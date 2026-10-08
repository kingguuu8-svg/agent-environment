"""Install a paired device with native background jobs and outbound SSH."""

import argparse
import base64
import getpass
import hashlib
import http.client
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

from device_services import start

FD_DIGESTS = {
    "linux-x64": "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
    "linux-arm64": "d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4",
    "darwin-x64": "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
    "darwin-arm64": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
    "win32-x64": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
    "win32-arm64": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
}


def fd_archive(target_os, architecture):
    digest = FD_DIGESTS.get(target_os + "-" + architecture)
    if not digest:
        raise RuntimeError("文件查找依赖支持 x64 和 arm64。")
    cpu = {"x64": "x86_64", "arm64": "aarch64"}[architecture]
    target = {
        "linux": "unknown-linux-musl",
        "darwin": "apple-darwin",
        "win32": "pc-windows-msvc",
    }[target_os]
    suffix = "zip" if target_os == "win32" else "tar.gz"
    return f"fd-v10.5.0-{cpu}-{target}.{suffix}", digest


def say(message):
    print(message, flush=True)


def save(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    if os.name != "nt":
        os.fchmod(fd, mode)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        output.write(content)
    temporary.replace(path)


def command(args, *, capture=False, timeout=180, input=None):
    result = subprocess.run(
        args, text=True, input=input, capture_output=capture, timeout=timeout
    )
    if result.returncode:
        detail = result.stderr.strip()[-1800:] if capture else ""
        raise RuntimeError(detail or f"命令未完成：{args[0]}")
    return result.stdout if capture else None


def node_version(path):
    try:
        version = command([str(path), "--version"], capture=True, timeout=10)
        return tuple(int(part) for part in version.strip().lstrip("v").split(".")) >= (
            22,
            19,
            0,
        )
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return False


def https_context():
    certificates = ssl.create_default_context()
    # The official macOS Python package can start without its own CA bundle.
    if sys.platform == "darwin" and not certificates.cert_store_stats()["x509_ca"]:
        roots = command(
            [
                "security",
                "find-certificate",
                "-a",
                "-p",
                "/System/Library/Keychains/SystemRootCertificates.keychain",
            ],
            capture=True,
            timeout=15,
        )
        certificates.load_verify_locations(cadata=roots)
    return certificates


def download_bytes(url, limit):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(
                url, timeout=30, context=https_context()
            ) as response:
                data = response.read(limit + 1)
                expected = response.headers.get("Content-Length")
            if len(data) > limit:
                raise ValueError("下载文件大小超出预期。")
            if expected is not None and len(data) != int(expected):
                raise http.client.IncompleteRead(data, int(expected) - len(data))
            return data
        except (OSError, http.client.HTTPException) as error:
            if attempt == 2:
                raise RuntimeError(
                    "文件查找依赖下载失败，请检查网络后重跑安装器。"
                ) from error
            say("下载中断，正在重试…")
            time.sleep(2)


def runtime(base):
    for node in [
        shutil.which("node"),
        str(base / ("node/node.exe" if os.name == "nt" else "node/bin/node")),
    ]:
        if node and node_version(node):
            npm = (
                (Path(node).resolve().parent / "node_modules/npm/bin/npm-cli.js")
                if os.name == "nt"
                else (
                    Path(node).resolve().parent.parent
                    / "lib/node_modules/npm/bin/npm-cli.js"
                )
            )
            if npm.exists():
                return str(Path(node).resolve()), npm
            found = shutil.which("npm")
            if found:
                try:
                    command([found, "--version"], capture=True, timeout=15)
                    return str(Path(node).resolve()), Path(found).resolve()
                except (OSError, RuntimeError, subprocess.TimeoutExpired):
                    pass
    architecture = {
        "x86_64": "x64",
        "amd64": "x64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(platform.machine().lower())
    if not architecture:
        raise RuntimeError("当前 Node 自动安装支持 x86_64 和 arm64。")
    say("正在安装用户目录内的 Node.js（首次安装需要下载）…")
    origin = "https://nodejs.org/dist/latest-v22.x/"
    certificates = https_context()
    with urllib.request.urlopen(
        origin + "SHASUMS256.txt", timeout=30, context=certificates
    ) as response:
        hashes = response.read(256 * 1024).decode()
    target = {"linux": "linux", "darwin": "darwin", "win32": "win"}[sys.platform]
    suffix = "zip" if os.name == "nt" else "tar.gz"
    match = re.search(
        rf"^([a-f0-9]{{64}})\s+(node-v22\.\d+\.\d+-{target}-{architecture}\.{suffix})$",
        hashes,
        re.M,
    )
    if not match:
        raise RuntimeError("Node.js 下载索引不可用，请重试。")
    digest, filename = match.groups()
    with tempfile.TemporaryDirectory(dir=base) as directory:
        archive = Path(directory) / filename
        hasher, total = hashlib.sha256(), 0
        with (
            urllib.request.urlopen(
                origin + filename, timeout=60, context=certificates
            ) as response,
            archive.open("wb") as output,
        ):
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 150 * 1024 * 1024:
                    raise RuntimeError("Node.js 下载大小超出预期。")
                hasher.update(chunk)
                output.write(chunk)
        if hasher.hexdigest() != digest:
            raise RuntimeError("Node.js 下载校验失败，请重试。")
        if os.name == "nt":
            with zipfile.ZipFile(archive) as package:
                package.extractall(directory)
        else:
            command(["tar", "-xzf", str(archive), "-C", directory], capture=True)
        extracted = Path(directory) / filename.removesuffix("." + suffix)
        if not node_version(
            extracted / ("node.exe" if os.name == "nt" else "bin/node")
        ):
            raise RuntimeError("下载的 Node.js 无法运行。请检查发行版的 glibc 版本。")
        previous = base / "node.previous"
        if previous.exists():
            shutil.rmtree(previous)
        if (base / "node").exists():
            (base / "node").rename(previous)
        extracted.rename(base / "node")
    return str(
        base / ("node/node.exe" if os.name == "nt" else "node/bin/node")
    ), base / (
        "node/node_modules/npm/bin/npm-cli.js"
        if os.name == "nt"
        else "node/lib/node_modules/npm/bin/npm-cli.js"
    )


def ssh_args(config, key, known):
    return [
        "ssh",
        "-F",
        "NUL" if os.name == "nt" else "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        f'UserKnownHostsFile="{known.as_posix().replace(chr(34), chr(92) + chr(34))}"',
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-p",
        str(config["port"]),
        "-i",
        str(key),
    ]


def search_tools(base, node, npm_cli):
    existing = shutil.which("rg")
    if existing:
        command([existing, "--version"], capture=True, timeout=10)
        return [str(Path(existing).parent)]
    architecture = command(
        [node, "-p", "process.arch"], capture=True, timeout=10
    ).strip()
    if architecture not in {"x64", "arm64"}:
        raise RuntimeError("搜索依赖支持 x64 和 arm64。")
    name = f"ripgrep-{sys.platform}-{architecture}"
    directory = base / "search/node_modules/@vscode" / name / "bin"
    binary = directory / ("rg.exe" if os.name == "nt" else "rg")
    if not binary.exists():
        say("正在准备 Pi 的搜索依赖…")
        # Microsoft's VS Code packages ship the real binary on the npm CDN.
        # Preparing it now avoids a lazy GitHub download on the first grep call.
        command(
            [
                *(
                    [node, str(npm_cli)]
                    if str(npm_cli).endswith(".js")
                    else [str(npm_cli)]
                ),
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--prefix",
                str(base / "search"),
                "--registry",
                "https://registry.npmjs.org",
                f"@vscode/{name}@1.18.0",
            ],
            capture=True,
            timeout=180,
        )
    command([str(binary), "--version"], capture=True, timeout=10)
    return [str(directory)]


def file_finder(base, node, source=None):
    existing = shutil.which("fd") or shutil.which("fdfind")
    if existing:
        command([existing, "--version"], capture=True, timeout=10)
        return [str(Path(existing).parent)]
    directory = base / "finder"
    directory.mkdir(exist_ok=True, mode=0o700)
    binary = directory / ("fd.exe" if os.name == "nt" else "fd")
    if not binary.exists():
        architecture = command(
            [node, "-p", "process.arch"], capture=True, timeout=10
        ).strip()
        filename, digest = fd_archive(sys.platform, architecture)
        suffix = "zip" if os.name == "nt" else "tar.gz"
        say("正在准备 Pi 的文件查找依赖…")
        with tempfile.TemporaryDirectory(dir=base) as temporary:
            archive = Path(temporary) / filename
            packaged = source / (filename + ".b64") if source is not None else None
            data = (
                base64.b64decode(packaged.read_text(), validate=True)
                if packaged is not None and packaged.exists()
                else download_bytes(
                    "https://github.com/sharkdp/fd/releases/download/v10.5.0/"
                    + filename,
                    20 * 1024 * 1024,
                )
            )
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError("fd 下载校验失败，请重试。")
            archive.write_bytes(data)
            if suffix == "zip":
                with zipfile.ZipFile(archive) as package:
                    contents = package.read(
                        next(
                            n for n in package.namelist() if Path(n).name == binary.name
                        )
                    )
            else:
                with tarfile.open(archive) as package:
                    member = next(
                        m
                        for m in package.getmembers()
                        if Path(m.name).name == binary.name and m.isfile()
                    )
                    contents = package.extractfile(member).read()
            binary.write_bytes(contents)
            binary.chmod(0o755)
    command([str(binary), "--version"], capture=True, timeout=10)
    return [str(directory)]


def key(base, name):
    path = base / name
    if not path.exists():
        command(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path)],
            capture=True,
        )
    return " ".join(path.with_suffix(".pub").read_text().split()[:2])


def check_services():
    try:
        command(["systemctl", "--user", "show-environment"], capture=True, timeout=10)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(
            "需要 systemd 用户服务。请以准备接入的用户登录完整 Linux 会话后重试。"
        ) from error


def windows_bash(base):
    if os.name != "nt":
        return []
    candidates = [
        base / "git/bin/bash.exe",
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return [str(candidate.parent), str(candidate.parent.parent / "cmd")]
    say("正在安装 Git for Windows，提供 Pi 所需的 Bash…")
    metadata = urllib.request.Request(
        "https://api.github.com/repos/git-for-windows/git/releases/latest",
        headers={"User-Agent": "remote-dsh-installer"},
    )
    with urllib.request.urlopen(metadata, timeout=30) as response:
        release = json.load(response)
    asset = next(
        item
        for item in release["assets"]
        if re.fullmatch(r"Git-[0-9.]+-64-bit\.exe", item["name"])
    )
    with tempfile.TemporaryDirectory(dir=base) as directory:
        installer = Path(directory) / "git-setup.exe"
        with (
            urllib.request.urlopen(
                asset["browser_download_url"], timeout=60
            ) as response,
            installer.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
        from device_services import literal, powershell

        command(
            powershell(
                "if((Get-AuthenticodeSignature "
                + literal(installer)
                + ").Status -ne 'Valid'){throw 'Git installer signature check failed'}"
            ),
            capture=True,
        )
        command(
            [
                str(installer),
                "/VERYSILENT",
                "/NORESTART",
                "/CURRENTUSER",
                "/DIR=" + str(base / "git"),
            ],
            capture=True,
            timeout=300,
        )
    if not candidates[0].exists():
        raise RuntimeError("Git Bash 安装未完成，请重试。")
    return [str(base / "git/bin"), str(base / "git/cmd")]


def install(args):
    target = {"linux": "linux", "darwin": "mac", "win32": "windows"}.get(sys.platform)
    if not target or sys.version_info < (3, 11):
        raise RuntimeError("需要 Linux、macOS 或 Windows，以及 Python 3.11+。")
    if target == "linux":
        check_services()
    pairing = json.loads((args.source / "pairing.json").read_text())
    if pairing.get("targetOs", target) != target:
        raise RuntimeError("安装包与本机系统不匹配，请选择正确系统重新下载。")
    base = Path.home() / ".local/share/remote-dsh-device"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (base / "install.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            lock.write(b"\0")
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError) as error:
        raise RuntimeError("另一个安装器正在运行，请等待它完成。") from error
    with lock:
        identity_file = base / "identity.json"
        existing = (
            json.loads(identity_file.read_text()) if identity_file.exists() else None
        )
        if existing and (existing["host"], existing["port"]) != (
            pairing["host"],
            pairing["port"],
        ):
            raise RuntimeError("此设备已接入另一个平台，请使用原平台的安装器。")
        if not existing and pairing["expiresAt"] <= time.time():
            raise RuntimeError("安装器已过期，请在 Web 的“接入新设备”重新下载。")
        say("[1/4] 检查运行环境…")
        node, npm_cli = runtime(base)
        search_path = os.pathsep.join(
            [
                str(Path(node).parent),
                *windows_bash(base),
                *search_tools(base, node, npm_cli),
                *file_finder(base, node, args.source),
            ]
        )
        if os.name != "nt":
            save(
                base / "npm",
                "#!/bin/sh\nexec " + shlex.join([node, str(npm_cli)]) + ' "$@"\n',
                0o755,
            )
        entry_public, host_public = key(base, "cloud-entry-key"), key(base, "host-key")
        save(base / "cloud-known_hosts", pairing["knownHosts"])
        claim_file = base / "pending-registration.json"
        pending = json.loads(claim_file.read_text()) if claim_file.exists() else None
        cloud_identity = {"host": pairing["host"], "port": pairing["port"]}
        if (
            pending
            and pending["pairingId"] != pairing["pairingId"]
            and pending.get("cloud") != cloud_identity
        ):
            pending = None
        if existing:
            local_port = existing["localPort"]
        elif pending:
            local_port = pending["request"]["localPort"]
        else:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                local_port = probe.getsockname()[1]
        say("[2/4] 与云端配对…" if not existing else "[2/4] 复用已登记设备…")
        if existing:
            profile = json.loads((base / "client.json").read_text())
            cloud_port, machine = existing["cloudPort"], existing["machine"]
        else:
            token = pending["request"]["token"] if pending else secrets.token_hex(32)
            registration = (
                pending["request"]
                if pending
                else {
                    "entryPublicKey": entry_public,
                    "hostPublicKey": host_public,
                    "user": re.sub(r"[^a-zA-Z0-9_.-]", "_", getpass.getuser())[:64],
                    "hostname": socket.gethostname()[:80],
                    "label": args.name or socket.gethostname()[:80],
                    "node": node,
                    "npm": str(npm_cli),
                    "python": str(Path(sys.executable).resolve()),
                    "workerRoot": str(base / "worker"),
                    "workspace": str(Path.cwd()),
                    "localPort": local_port,
                    "kind": "bridge",
                    "platform": target,
                    "token": token,
                }
            )
            save(
                claim_file,
                json.dumps(
                    {
                        "pairingId": pairing["pairingId"],
                        "cloud": cloud_identity,
                        "request": registration,
                    }
                ),
            )
            pairing_key = base / "pairing-key"
            save(pairing_key, pairing["privateKey"])
            try:
                response = command(
                    [
                        *ssh_args(pairing, pairing_key, base / "cloud-known_hosts"),
                        pairing["host"],
                    ],
                    capture=True,
                    input=json.dumps(registration),
                )
                result = json.loads(response)
            finally:
                pairing_key.unlink(missing_ok=True)
            cloud_port, machine = result["cloudPort"], result["machine"]
            profile = {
                "machine": machine,
                "nativeJobs": True,
                "python": str(Path(sys.executable).resolve()),
                "cloud": {
                    "host": pairing["host"],
                    "port": pairing["port"],
                    "identity_file": str(base / "cloud-entry-key"),
                    "known_hosts_file": str(base / "cloud-known_hosts"),
                    "base": result["base"],
                    "node": result["node"],
                    "webPort": result.get("webPort", 3080),
                },
            }
            save(
                base / "bridge.json",
                json.dumps(
                    {
                        "token": registration["token"],
                        "localPort": local_port,
                        "node": node,
                        "npm": str(npm_cli),
                        "workerRoot": str(base / "worker"),
                        "path": search_path,
                    }
                ),
            )
            save(base / "client.json", json.dumps(profile, indent=2))
            save(
                identity_file,
                json.dumps(
                    {
                        "machine": machine,
                        "host": pairing["host"],
                        "port": pairing["port"],
                        "localPort": local_port,
                        "cloudPort": cloud_port,
                        "kind": "bridge",
                    },
                    indent=2,
                ),
            )
            claim_file.unlink(missing_ok=True)
        say("[3/4] 启动后台连接…")
        configuration_changed = False
        if not existing or existing.get("kind", "ssh") == "bridge":
            bridge_file = base / "bridge.json"
            before = json.loads(bridge_file.read_text())
            refreshed = {
                **before,
                "node": node,
                "npm": str(npm_cli),
                "path": search_path,
            }
            configuration_changed = refreshed != before
            save(bridge_file, json.dumps(refreshed))
        app = base / "app"
        app.mkdir(exist_ok=True, mode=0o700)
        app_changed = False
        for name in [
            "install-dsh-client.py",
            "dsh.mjs",
            "dsh-remote.mjs",
            "state-json.mjs",
            "device_bridge.py",
            "device_services.py",
            "device_supervisor.py",
            "bootstrap.py",
        ]:
            content = (args.source / name).read_text()
            app_changed |= (
                not (app / name).exists() or (app / name).read_text() != content
            )
            save(app / name, content)
        if existing and existing.get("kind", "ssh") == "ssh":
            command(
                [
                    "systemctl",
                    "--user",
                    "start",
                    "remote-dsh-device-sshd.service",
                    "remote-dsh-device-link.service",
                ],
                capture=True,
            )
        else:
            start(
                "device-bridge",
                [
                    sys.executable,
                    str(app / "device_bridge.py"),
                    "--config",
                    str(base / "bridge.json"),
                ],
                force=app_changed or configuration_changed,
                supervisor=app / "device_supervisor.py",
            )
            start(
                "device-link",
                [
                    *ssh_args(
                        pairing, base / "cloud-entry-key", base / "cloud-known_hosts"
                    ),
                    "-N",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-R",
                    f"127.0.0.1:{cloud_port}:127.0.0.1:{local_port}",
                    pairing["host"],
                ],
                force=app_changed,
                supervisor=app / "device_supervisor.py",
            )
        previous = shutil.which("dsh")
        default_bin = Path.home() / ".local/bin"
        bin_dir = (
            Path(previous).parent
            if previous and Path(previous).parent.is_relative_to(Path.home())
            else default_bin
        )
        command(
            [
                sys.executable,
                str(app / "install-dsh-client.py"),
                "--profile",
                str(base / "client.json"),
                "--node",
                node,
                "--bin-dir",
                str(bin_dir),
            ],
            capture=True,
        )
        say("[4/4] 检查云端和本机工具连接（首次会自动安装 Pi 工具）…")
        deadline, last = time.monotonic() + 300, ""
        while time.monotonic() < deadline:
            try:
                raw = command(
                    [
                        *ssh_args(
                            pairing,
                            base / "cloud-entry-key",
                            base / "cloud-known_hosts",
                        ),
                        pairing["host"],
                    ],
                    capture=True,
                    timeout=250,
                    input=json.dumps(
                        {
                            "workspace": str(Path.cwd()),
                            **(
                                {"pairingId": pairing["pairingId"]}
                                if existing and pairing["expiresAt"] > time.time()
                                else {}
                            ),
                        }
                    )
                    + "\n",
                )
                ready = json.loads(raw)
                if ready.get("type") != "ready":
                    raise RuntimeError(ready.get("error", "Cloud entry is not ready"))
                break
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                last = str(error)
                time.sleep(2)
        else:
            raise RuntimeError(
                f"设备已登记，连接尚未就绪。修复后重跑安装器即可继续。\n{last}"
            )
        say(f"接入成功：{args.name or socket.gethostname()}。会话保存在 VPS4。")
        if ready.get("onboardingError"):
            say("本机连接已恢复，页面接入进度暂未更新：" + ready["onboardingError"])
        if str(bin_dir) not in os.environ.get("PATH", "").split(os.pathsep):
            if os.name == "nt":
                from device_services import literal, powershell

                command(
                    powershell(
                        "$p=[Environment]::GetEnvironmentVariable('Path','User');$d="
                        + literal(bin_dir)
                        + ";if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',($d+';'+$p),'User')}"
                    ),
                    capture=True,
                )
                say("重新打开终端即可使用 dsh。")
            else:
                line = 'export PATH="$HOME/.local/bin:$PATH"'
                files = [
                    Path.home() / ".profile",
                    Path.home()
                    / (
                        ".zshrc"
                        if target == "mac"
                        or os.environ.get("SHELL", "").endswith("zsh")
                        else ".bashrc"
                    ),
                ]
                for file in files:
                    original = file.read_text() if file.exists() else ""
                    if line not in original:
                        with file.open("a") as output:
                            output.write("\n# Remote DSH command\n" + line + "\n")
                say('当前终端先执行：export PATH="$HOME/.local/bin:$PATH"')
        say("在任意项目目录执行：dsh web --remote")
        if not args.no_open:
            command([node, str(app / "dsh.mjs"), "web", "--remote"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--name", help="设备显示名称，默认使用主机名")
    parser.add_argument("--no-open", action="store_true", help="接入后暂不打开浏览器")
    args = parser.parse_args()
    try:
        install(args)
    except (Exception, KeyboardInterrupt) as error:
        print(f"接入未完成：{error}", file=sys.stderr)
        print("可以修复后重跑同一安装器；已登记的设备会继续沿用。", file=sys.stderr)
        sys.exit(1)
