"""Issue expiring device installers and register their SSH keys on the cloud host."""

import argparse
import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import shlex
import socket
import struct
import subprocess
import sys
import time
import uuid
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath

from installer_templates import LINUX, MAC, WINDOWS

TTL = 15 * 60


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


@contextlib.contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def public_key(value):
    if not isinstance(value, str) or len(value) > 256:
        raise ValueError("Invalid device public key")
    parts = value.split()
    if len(parts) != 2 or parts[0] != "ssh-ed25519":
        raise ValueError("Use an Ed25519 public key")
    raw = base64.b64decode(parts[1], validate=True)
    expected = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32)
    if len(raw) != len(expected) + 32 or not raw.startswith(expected):
        raise ValueError("Invalid Ed25519 key data")
    return " ".join(parts)


def key_line(options, public, comment):
    return f"{options} {public_key(public)} {comment}"


def authorized(base, *, add=None, remove=()):
    directory = base / ".ssh"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / "authorized_keys"
    with locked(directory / "remote-dsh-authorized.lock"):
        original = path.read_text() if path.exists() else ""
        lines = [
            line
            for line in original.splitlines()
            if line.rsplit(" ", 1)[-1] not in remove
        ]
        if add:
            public = add.split(" ssh-ed25519 ", 1)[1].split()[0]
            existing = [line for line in lines if public in line.split()]
            if existing and existing != [add]:
                raise ValueError(
                    "This public key already has different SSH permissions"
                )
            if not existing:
                lines.append(add)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write("\n".join(lines) + "\n")


def prune(runtime, state, user_home):
    expired = []
    for path in (state / "pairing").glob("*/receipt.json"):
        receipt = json.loads(path.read_text())
        if receipt["expiresAt"] <= time.time():
            expired.append("remote-dsh-pair-" + path.parent.name)
    if expired:
        authorized(user_home, remove=expired)


def create(runtime, state, user_home, target_os="linux"):
    if target_os not in {"linux", "mac", "windows"}:
        raise ValueError("Choose Linux, macOS or Windows")
    platform = json.loads((runtime / "device-platform.json").read_text())
    bundle = json.loads((runtime / "device-installer.bundle.json").read_text())
    with locked(state / "pairing.lock"):
        prune(runtime, state, user_home)
        pairing_id = uuid.uuid4().hex
        directory = state / "pairing" / pairing_id
        directory.mkdir(parents=True, mode=0o700)
        key = directory / "key"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
            check=True,
        )
        expires = int(time.time()) + TTL
        receipt = {
            "expiresAt": expires,
            "targetOs": target_os,
            "publicKey": public_key(
                " ".join(key.with_suffix(".pub").read_text().split()[:2])
            ),
        }
        save(directory / "receipt.json", receipt)
        command = shlex.join(
            [
                sys.executable,
                str(runtime / "device_onboarding.py"),
                "pair",
                "--runtime",
                str(runtime),
                "--state",
                str(state),
                "--pairing",
                pairing_id,
            ]
        )
        escaped = command.replace("\\", "\\\\").replace('"', '\\"')
        expiration = datetime.fromtimestamp(expires, timezone.utc).strftime(
            "%Y%m%d%H%M%SZ"
        )
        authorized(
            user_home,
            add=key_line(
                f'restrict,expiry-time="{expiration}",command="{escaped}"',
                receipt["publicKey"],
                "remote-dsh-pair-" + pairing_id,
            ),
        )
        config = {
            **platform,
            "pairingId": pairing_id,
            "expiresAt": expires,
            "privateKey": key.read_text(),
            "targetOs": target_os,
        }
        key.unlink()
        package = {
            **bundle["files"],
            **bundle.get("archives", {}).get(target_os, {}),
            "pairing.json": json.dumps(config),
        }
        packed = base64.b64encode(zlib.compress(json.dumps(package).encode())).decode()
        template = {"linux": LINUX, "mac": MAC, "windows": WINDOWS}[target_os]
        content = template.replace("__PACKAGE__", packed)
        if target_os == "windows":
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
                output.writestr("dsh-connect.ps1", content.encode("utf-8-sig"))
                output.writestr(
                    "dsh-connect.cmd",
                    '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-connect.ps1" %*\r\nif errorlevel 1 pause\r\n',
                )
            content = base64.b64encode(archive.getvalue()).decode()
        return {
            "filename": {
                "linux": "dsh-connect-linux.sh",
                "mac": "dsh-connect-mac.command",
                "windows": "dsh-connect-windows.zip",
            }[target_os],
            "content": content,
            "encoding": "base64" if target_os == "windows" else "utf-8",
            "expiresAt": expires * 1000,
            "pairingId": pairing_id,
        }


def status(runtime, state, pairing_id):
    if not isinstance(pairing_id, str) or not re.fullmatch(r"[a-f0-9]{32}", pairing_id):
        raise ValueError("Invalid pairing identity")
    with locked(state / "pairing.lock"):
        path = state / "pairing" / pairing_id / "receipt.json"
        if not path.exists():
            raise ValueError("找不到安装器记录，请重新下载安装器。")
        receipt = json.loads(path.read_text())
        result = receipt.get("result", {})
        target = json.loads((runtime / "dsh-targets.json").read_text())["targets"].get(
            result.get("machine")
        )
        registered = receipt.get("complete") and target is not None
        phase = (
            "registered"
            if registered
            else "expired"
            if receipt["expiresAt"] <= time.time()
            else "registering"
            if result
            else "waiting"
        )
        return {
            "phase": phase,
            "platform": receipt.get("targetOs", "linux"),
            "expiresAt": receipt["expiresAt"] * 1000,
            **(
                {
                    "machine": {
                        "id": result["machine"],
                        "label": target.get("label", result["machine"]),
                        "workspace": target["workspace"],
                    }
                }
                if registered
                else {}
            ),
        }


def validate_request(request):
    if not isinstance(request, dict):
        raise ValueError("Invalid device registration")
    if request.get("kind", "ssh") not in {"ssh", "bridge"} or request.get(
        "platform", "linux"
    ) not in {"linux", "mac", "windows"}:
        raise ValueError("Invalid device transport or platform")
    for name in ["entryPublicKey", "hostPublicKey"]:
        request[name] = public_key(request.get(name))
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", request.get("user", "")):
        raise ValueError("Invalid device user")
    for name in ["node", "npm", "python", "workerRoot", "workspace"]:
        value = request.get(name)
        if (
            not isinstance(value, str)
            or not (
                value.startswith("/")
                or request.get("platform") == "windows"
                and PureWindowsPath(value).is_absolute()
            )
            or len(value) > 4096
            or any(char in value for char in "\x00\n\r")
        ):
            raise ValueError(f"Invalid device path: {name}")
    if (
        not isinstance(request.get("localPort"), int)
        or not 1024 <= request["localPort"] <= 65535
    ):
        raise ValueError("Invalid local port")
    for name in ["hostname", "label"]:
        if (
            not isinstance(request.get(name), str)
            or not request[name].strip()
            or len(request[name]) > 80
            or any(ord(char) < 32 for char in request[name])
        ):
            raise ValueError(f"Invalid device {name}")
    if request.get("kind") == "bridge":
        token = request.get("token")
        if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
            raise ValueError("Invalid device bridge token")


def free_cloud_port(targets):
    used = {target.get("port") for target in targets.values()}
    for port in range(42023, 43024):
        if port in used:
            continue
        try:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
            return port
        except OSError:
            pass
    raise ValueError("No free device ports")


def pair(runtime, state, user_home, pairing_id, request):
    if not re.fullmatch(r"[a-f0-9]{32}", pairing_id):
        raise ValueError("Invalid pairing identity")
    validate_request(request)
    receipt_path = state / "pairing" / pairing_id / "receipt.json"
    # Pairing claim and target allocation share this lock so retries, concurrent
    # installers and response loss cannot overwrite another device's identity.
    with locked(state / "pairing.lock"), locked(runtime / "dsh-targets.lock"):
        receipt = json.loads(receipt_path.read_text())
        if receipt["expiresAt"] <= time.time():
            raise ValueError("安装器已过期，请在 Web 页面重新下载。")
        if request.get("platform", "linux") != receipt.get("targetOs", "linux"):
            raise ValueError("安装包与设备操作系统不匹配。")
        fingerprint = hashlib.sha256(
            json.dumps(request, sort_keys=True).encode()
        ).hexdigest()
        if receipt.get("claim") and receipt["claim"] != fingerprint:
            raise ValueError("此安装器已经用于另一台设备，请重新下载。")
        targets_file = runtime / "dsh-targets.json"
        configuration = json.loads(targets_file.read_text())
        targets = configuration.setdefault("targets", {})
        if "result" not in receipt:
            slug = (
                re.sub("[^a-z0-9]+", "_", request["hostname"].lower())
                .strip("_")[:16]
                .rstrip("_")
                or "device"
            )
            machine = (
                "d_"
                + slug
                + "_"
                + hashlib.sha256(request["entryPublicKey"].encode()).hexdigest()[:8]
            )
            receipt["claim"] = fingerprint
            platform = json.loads((runtime / "device-platform.json").read_text())
            reserved = {
                **targets,
                **{
                    path.parent.name: {"port": saved["result"]["cloudPort"]}
                    for path in (state / "pairing").glob("*/receipt.json")
                    if "result" in (saved := json.loads(path.read_text()))
                },
            }
            receipt["result"] = {
                "machine": machine,
                "cloudPort": targets[machine]["port"]
                if machine in targets
                else free_cloud_port(reserved),
                "localPort": request["localPort"],
                "base": str(runtime),
                "node": platform.get("node", "node"),
            }
            save(receipt_path, receipt)
        result = receipt["result"]
        machine, port = result["machine"], result["cloudPort"]
        target = {
            "host": request["user"] + "@127.0.0.1",
            "port": port,
            "identity_file": str(runtime / "keys/cloud-to-vps1"),
            "known_hosts_file": str(runtime / (machine + "-known_hosts")),
            "node": request["node"],
            "npm": request["npm"],
            "python": request["python"],
            "remote_base": request["workerRoot"],
            "workspace": request["workspace"],
            "label": request["label"],
        }
        if request.get("kind") == "bridge":
            target = {
                key: value
                for key, value in target.items()
                if key not in {"identity_file", "known_hosts_file"}
            }
            target.update(
                {
                    "host": "127.0.0.1",
                    "kind": "bridge",
                    "token": request["token"],
                    "platform": request["platform"],
                }
            )
        if machine in targets and targets[machine] != target:
            raise ValueError("Device registration conflicts with an existing target")
        entry = shlex.join(
            [
                result["node"],
                str(runtime / "dsh-entry.mjs"),
                "--state",
                str(state),
                "--machine",
                machine,
            ]
        )
        escaped = entry.replace("\\", "\\\\").replace('"', '\\"')
        authorized(
            user_home,
            add=key_line(
                f'restrict,port-forwarding,permitopen="127.0.0.1:3080",permitlisten="127.0.0.1:{port}",command="{escaped}"',
                request["entryPublicKey"],
                "remote-dsh-device-" + machine,
            ),
        )
        if request.get("kind") != "bridge":
            known = runtime / (machine + "-known_hosts")
            known.write_text(f"[127.0.0.1]:{port} {request['hostPublicKey']}\n")
            known.chmod(0o600)
        targets[machine] = target
        save(targets_file, configuration)
        result = {
            **result,
            "toolPublicKey": " ".join(
                (runtime / "keys/cloud-to-vps1.pub").read_text().split()[:2]
            ),
        }
        receipt["complete"] = True
        save(receipt_path, receipt)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "pair", "status"])
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--pairing")
    parser.add_argument(
        "--platform", default="linux", choices=["linux", "mac", "windows"]
    )
    args = parser.parse_args()
    if args.action == "create":
        result = create(args.runtime, args.state, Path.home(), args.platform)
    elif args.action == "status":
        result = status(args.runtime, args.state, args.pairing)
    else:
        request = json.loads(sys.stdin.buffer.read(65537))
        result = pair(args.runtime, args.state, Path.home(), args.pairing, request)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
