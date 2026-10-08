#!/usr/bin/env python3
"""Initialize and run a personal Agent Environment from a source checkout."""

import argparse
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DEFAULT_DIRECTORY = ROOT / ".local/platform"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".platform-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def executable(value):
    result = shutil.which(str(value))
    if not result:
        raise ValueError(f"Executable not found: {value}")
    # A venv Python symlink must retain its invocation path to select that venv.
    return str(Path(result).absolute())


def node_path(value):
    node = executable(value)
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if not re.fullmatch(r"v\d+\.\d+\.\d+", version) or tuple(map(int, version[1:].split("."))) < (22, 19, 0):
        raise ValueError("Node.js 22.19.0 or newer is required")
    return node


def valid_url(value, port):
    url = urlsplit(value)
    if (url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}
        or not url.hostname or not (url.scheme == "https" or url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost"})):
        raise ValueError("Use an HTTPS origin, or an HTTP loopback origin for local development")
    if url.scheme == "http" and (url.port or 80) != port:
        raise ValueError("A local HTTP URL must use the Environment listener port")
    return value.rstrip("/") + "/"


def target_config(path):
    if path is None:
        return {"targets": {}}
    config = load(path)
    if not isinstance(config.get("targets"), dict):
        raise ValueError("Target configuration needs a targets object")
    for machine, target in config["targets"].items():
        if machine == "cloud" or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", machine) or "__" in machine:
            raise ValueError(f"Invalid or reserved machine ID: {machine}")
        host = target.get("host")
        if not isinstance(host, str) or not host or host.startswith("-") or any(c.isspace() for c in host):
            raise ValueError(f"Invalid SSH host for {machine}")
        port = target.get("port", 22)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError(f"Invalid SSH port for {machine}")
        for field in ["identity_file", "known_hosts_file"]:
            if target.get(field):
                target[field] = str((path.parent / Path(target[field]).expanduser()).resolve())
    return config


def initialize(args):
    directory = args.directory.resolve()
    if directory.exists():
        raise ValueError("Runtime directory already exists; use start, or choose a new --directory. Existing state was preserved.")
    workspace = args.workspace.expanduser().resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("Workspace must be an existing directory")
    node = node_path(args.node)
    python = executable(args.python)
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", args.account):
        raise ValueError("Account must contain 1–64 ASCII letters, digits, underscores or hyphens")
    if not 1 <= args.port <= 65535 or not 1 <= args.web_port <= 65535 or args.port == args.web_port:
        raise ValueError("Environment and Web ports must be different integers from 1 to 65535")
    url = valid_url(args.url or f"http://127.0.0.1:{args.port}/", args.port)
    targets = target_config(args.targets.resolve() if args.targets else None)
    if args.label:
        targets["cloudLabel"] = args.label
    model = None
    if args.mode == "dsh":
        if args.model is None:
            raise ValueError("DSH requires --model; see models.example.json. Environment-only mode needs no model.")
        model = load(args.model)
        if not (ROOT / "dsh-product/node_modules/@deepseek-ai/dsh/package.json").exists():
            raise ValueError("Run scripts/setup.sh dsh before initializing DSH")
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged = Path(tempfile.mkdtemp(dir=directory.parent, prefix=".platform-init-"))
    key = secrets.token_urlsafe(32)
    try:
        save(staged / "platform.json", {
            "version": 1, "mode": args.mode, "workspace": str(workspace),
            "node": node, "python": python, "webPort": args.web_port,
        })
        save(staged / "dsh-targets.json", targets)
        save(staged / "environment-access.json", {
            "version": 1, "url": url, "port": args.port, "account": args.account,
            "credentialHash": hashlib.sha256((args.account + "\0" + key).encode()).hexdigest(),
        })
        connection = {"url": url, "account": args.account, "key": key}
        save(staged / "connection.md", "# Agent Environment\n\n将本文件交给正在使用的 Agent，并让它接入这个环境。\n\n```json\n"
             + json.dumps(connection, ensure_ascii=False, indent=2)
             + "\n```\n\n先 GET 网址读取协议，再使用 HTTP Basic 认证列出目标。选定目标后读取 context，将对应项目指令用于该工作区，再调用工具。每次调用明确指定 target。MCP 入口见协议。\n\n密钥允许使用所有已登记资源，工具沿用目标用户的系统权限。请将本文件保存在私有位置。\n")
        if urlsplit(url).scheme == "https":
            save(staged / "Caddyfile", urlsplit(url).netloc + " {\n    reverse_proxy 127.0.0.1:" + str(args.port) + "\n}\n")
        if model is not None:
            save(staged / "dsh-models.json", model)
            save(staged / "model.env.example", "# Replace this value, then save as model.env with mode 600.\nAGENT_MODEL_KEY=replace-with-your-model-key\n")
        (staged / "dsh-state").mkdir(mode=0o700)
        # Rename only into an absent destination; a concurrent initializer wins once.
        staged.rename(directory)
        staged = None
        if model is not None:
            try:
                subprocess.run([node, str(ROOT / "configure-dsh.mjs"), "--home", str(directory / "dsh-home"),
                                "--state", str(directory / "dsh-state"), "--workspace", str(workspace),
                                "--targets", str(directory / "dsh-targets.json"), "--python", python,
                                "--model", str(directory / "dsh-models.json")], check=True)
            except BaseException:
                shutil.rmtree(directory)
                raise
    finally:
        if staged is not None:
            shutil.rmtree(staged, ignore_errors=True)
    print(f"Initialized {args.mode}: {directory}\nPrivate Agent connection file: {directory / 'connection.md'}")
    print(f"Start: {shlex.join([sys.executable, str(ROOT / 'agent_environment.py'), 'start', '--directory', str(directory)])}")


def read_runtime(args):
    directory = args.directory.resolve()
    config = load(directory / "platform.json")
    if config.get("version") != 1 or config.get("mode") not in {"environment", "dsh"}:
        raise ValueError("Unsupported platform configuration")
    return directory, config


def model_environment(directory):
    result = dict(os.environ)
    path = directory / "model.env"
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise ValueError("model.env must have permissions 600")
        for line in path.read_text().splitlines():
            fields = shlex.split(line, comments=True)
            if not fields:
                continue
            if len(fields) != 1 or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", fields[0]):
                raise ValueError("model.env supports one NAME=value assignment per line")
            name, value = fields[0].split("=", 1)
            result.setdefault(name, value)
    return result


def launch_command(directory, config):
    common = ["--state", str(directory / "dsh-state"), "--workspace", config["workspace"]]
    if config["mode"] == "environment":
        return [config["node"], str(ROOT / "environment-server.mjs"), *common,
                "--targets", str(directory / "dsh-targets.json"), "--python", config["python"],
                "--access", str(directory / "environment-access.json")]
    return [config["node"], str(ROOT / "dsh-host.mjs"), *common, "--home", str(directory / "dsh-home"),
            "--port", str(config["webPort"])]


def doctor(args):
    directory, config = read_runtime(args)
    errors = []

    def check(label, operation):
        try:
            operation()
            print(f"PASS {label}")
        except Exception as error:
            errors.append(label)
            print(f"FAIL {label}: {error}")

    def verify_workspace():
        if not Path(config["workspace"]).is_dir():
            raise ValueError("Workspace is missing")

    def verify_access():
        access = load(directory / "environment-access.json")
        valid_url(access["url"], access["port"])
        if not re.fullmatch(r"[a-f0-9]{64}", access.get("credentialHash", "")):
            raise ValueError("Invalid credential digest")
        for name in ["platform.json", "environment-access.json", "connection.md", "dsh-targets.json"]:
            if (directory / name).stat().st_mode & 0o077:
                raise ValueError(f"{name} must have permissions 600")

    check("Node.js version", lambda: node_path(config["node"]))
    check("existing host workspace", verify_workspace)
    check("private configuration and access origin", verify_access)
    check("native Pi tool contract", lambda: subprocess.run([config["node"], str(ROOT / "worker.mjs"), "--check-manifest"], check=True, capture_output=True))
    targets = target_config(directory / "dsh-targets.json")
    if targets["targets"]:
        check("SSH client", lambda: executable("ssh"))
        check("Python MCP dependencies", lambda: subprocess.run([config["python"], "-c", "import mcp, uvicorn"], check=True, capture_output=True))
    if config["mode"] == "dsh":
        check("pinned DSH installation", lambda: subprocess.run([config["node"], str(ROOT / "dsh-product/patch-dsh.mjs")], check=True, capture_output=True))

        def verify_model():
            environment = model_environment(directory)
            models = load(directory / "dsh-models.json")
            providers = {**models.get("providers", {}), **models.get("dsh", {}).get("piAI", {}).get("providers", {})}
            names = {p.get("apiKeyEnv") or (p.get("apiKey", "").lstrip("$") if p.get("apiKey", "").startswith("$") else "REMOTE_MCP_CHECK_API_KEY") for p in providers.values()}
            if models.get("dsh", {}).get("deepseek"):
                names.add(models["dsh"]["deepseek"].get("apiKeyEnv", "DEEPSEEK_API_KEY"))
            for name in names:
                if not environment.get(name) or environment[name] == "replace-with-your-model-key":
                    raise ValueError(f"Missing model credential: {name}. Export it or set it in private model.env.")

        check("model credential references", verify_model)
    if errors:
        raise ValueError(f"{len(errors)} platform checks failed")
    print("Ready. Target reachability is checked when requesting its context; doctor makes no model requests.")


def start(args):
    directory, config = read_runtime(args)
    environment = model_environment(directory)
    if config["mode"] == "dsh":
        environment["REMOTE_ENVIRONMENT_ACCESS_CONFIG"] = str(directory / "environment-access.json")
    os.execve(config["node"], launch_command(directory, config), environment)


def service(args):
    directory, _ = read_runtime(args)
    # Emit a template, leaving installation/enablement under the user's control.
    def quote(value):
        return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'
    command = [sys.executable, str(ROOT / "agent_environment.py"), "start", "--directory", str(directory)]
    text = "\n".join(["[Unit]", "Description=Agent Environment", "Wants=network-online.target", "After=network-online.target", "",
                      "[Service]", "Type=simple", "WorkingDirectory=" + str(ROOT).replace("%", "%%"),
                      "ExecStart=" + " ".join(quote(part) for part in command), "Restart=on-failure", "RestartSec=10", "UMask=0077",
                      "", "[Install]", "WantedBy=default.target", ""])
    path = directory / "agent-environment.service"
    save(path, text)
    print(f"Generated: {path}\nSee docs/DEPLOYMENT.md for installing the user service.")


def prepare_devices(args):
    directory, config = read_runtime(args)
    if config["mode"] != "dsh":
        raise ValueError("Web device installers require DSH mode; environment-only mode uses targets.json over SSH")
    if not re.fullmatch(r"[^\s@:-]+@(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])", args.ssh_host) or not 1 <= args.ssh_port <= 65535:
        raise ValueError("Use a public user@hostname and a valid SSH port; SSH aliases are local to one machine")
    host_key = args.host_key.read_text().split()
    if len(host_key) < 2 or host_key[0] != "ssh-ed25519":
        raise ValueError("Use this server's Ed25519 SSH host public key")
    from build_device_installer import bundle
    from device_onboarding import public_key

    public = public_key(" ".join(host_key[:2]))
    hostname = args.ssh_host.split("@", 1)[1]
    known_host = hostname if args.ssh_port == 22 else f"[{hostname}]:{args.ssh_port}"
    platform = {"host": args.ssh_host, "port": args.ssh_port, "knownHosts": f"{known_host} {public}\n",
                "node": config["node"], "webPort": config["webPort"], "toolKey": str(directory / "keys/host-to-devices")}
    previous = directory / "device-platform.json"
    if previous.exists() and load(previous) != platform:
        raise ValueError("Device platform settings already exist and differ; existing devices were preserved")
    print("Preparing verified device assets…", flush=True)
    assets = bundle(ROOT, args.asset_dir)
    for name in ["device_onboarding.py", "installer_templates.py", "dsh-entry.mjs", "state-json.mjs"]:
        save(directory / name, (ROOT / name).read_text())
    key = Path(platform["toolKey"])
    key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not key.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
    save(directory / "device-installer.bundle.json", assets)
    save(previous, platform)
    print("Web device installers are ready. Open DSH and choose 接入新设备.")


def web(args):
    directory, config = read_runtime(args)
    if config["mode"] != "dsh":
        raise ValueError("Web requires DSH mode")
    url = load(directory / "dsh-state/web-url.json")["url"]
    parsed = urlsplit(url)
    if args.local_port:
        if not 1 <= args.local_port <= 65535:
            raise ValueError("Invalid local forwarding port")
        url = parsed._replace(netloc=f"127.0.0.1:{args.local_port}").geturl()
    path = directory / "web-launch.txt"
    save(path, url + "\n")
    if args.print_url:
        print(url)
    else:
        print(f"Private Web link saved to: {path}")
    if not args.no_open:
        webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    parsers = {name: commands.add_parser(name) for name in ["init", "start", "doctor", "service", "prepare-devices", "web"]}
    for command in parsers.values():
        command.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY)
    init = parsers["init"]
    init.add_argument("--mode", choices=["environment", "dsh"], default="environment")
    init.add_argument("--workspace", type=Path, default=Path.cwd())
    init.add_argument("--targets", type=Path)
    init.add_argument("--model", type=Path)
    init.add_argument("--url")
    init.add_argument("--port", type=int, default=3180)
    init.add_argument("--web-port", type=int, default=3080)
    init.add_argument("--account", default="owner")
    init.add_argument("--label")
    init.add_argument("--node", default="node")
    init.add_argument("--python", default=str(ROOT / ".venv/bin/python") if (ROOT / ".venv/bin/python").exists() else sys.executable)
    devices = parsers["prepare-devices"]
    devices.add_argument("--ssh-host", required=True)
    devices.add_argument("--ssh-port", type=int, default=22)
    devices.add_argument("--asset-dir", type=Path)
    devices.add_argument("--host-key", type=Path, default=Path("/etc/ssh/ssh_host_ed25519_key.pub"))
    browser = parsers["web"]
    browser.add_argument("--local-port", type=int)
    browser.add_argument("--no-open", action="store_true")
    browser.add_argument("--print", dest="print_url", action="store_true")
    args = parser.parse_args()
    actions = {"init": initialize, "start": start, "doctor": doctor, "service": service, "prepare-devices": prepare_devices, "web": web}
    try:
        actions[args.command](args)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
