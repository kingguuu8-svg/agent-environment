"""Register this Linux desktop with VPS4 using a private SSH daemon and a reverse link."""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from deploy_cloud_vps import AUTHORIZE, known_host, python_run
from gateway import load_targets, ssh_args

ROOT = Path(__file__).resolve().parent


def save(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, "w") as output:
        output.write(text)


def unit(description, command):
    return "\n".join(
        [
            "[Unit]",
            f"Description={description}",
            "After=network-online.target",
            "",
            "[Service]",
            "Type=simple",
            "ExecStart=" + " ".join(json.dumps(part) for part in command),
            "Restart=always",
            "RestartSec=12",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )


def setup(args):
    if (
        not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", args.machine)
        or args.machine == "cloud"
    ):
        raise ValueError("Use a lowercase machine identifier")
    if not all(1 <= port <= 65535 for port in (args.local_port, args.cloud_port)):
        raise ValueError("SSH ports must be between 1 and 65535")
    cloud = load_targets(args.config.resolve())["gateway"]
    base = Path.home() / ".local/share/remote-dsh-device"
    identity = {
        "machine": args.machine,
        "host": cloud["host"],
        "port": cloud["port"],
        "localPort": args.local_port,
        "cloudPort": args.cloud_port,
    }
    identity_file = base / "identity.json"
    if identity_file.exists():
        existing = json.loads(identity_file.read_text())
    elif (base / "client.json").exists():
        # Adopt an earlier installation once, using its actual reverse link.
        previous = json.loads((base / "client.json").read_text())
        link = (
            Path.home() / ".config/systemd/user/remote-dsh-device-link.service"
        ).read_text()
        ports = re.search(r"127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)", link)
        if not ports:
            raise ValueError("Cannot identify the existing managed device link")
        existing = {
            "machine": previous["machine"],
            "host": previous["cloud"]["host"],
            "port": previous["cloud"]["port"],
            "localPort": int(ports[2]),
            "cloudPort": int(ports[1]),
        }
    else:
        existing = identity
    if existing != identity:
        raise ValueError(
            "This device runtime is already registered with a different identity or ports; keep its existing configuration"
        )
    info = json.loads(
        python_run(
            cloud,
            "import json,pathlib; b=pathlib.Path.home()/'.local/share/remote-mcp-demo'; print(json.dumps({'base':str(b),'toolKey':str(b/'keys/cloud-to-vps1'),'public':(b/'keys/cloud-to-vps1.pub').read_text().strip()}))",
            {},
        )
    )
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    save(identity_file, json.dumps(identity, indent=2))
    node, sshd = shutil.which("node"), shutil.which("sshd")
    if not node or not sshd:
        raise ValueError(
            "Install Node.js >=22.19 and OpenSSH server on this device first"
        )
    for name in ["host-key", "cloud-entry-key"]:
        if not (base / name).exists():
            subprocess.run(
                [
                    "ssh-keygen",
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-C",
                    f"remote-dsh-{args.machine}",
                    "-f",
                    str(base / name),
                ],
                check=True,
            )
    save(base / "authorized_keys", "restrict " + info["public"] + "\n")
    save(base / "cloud-known_hosts", known_host(cloud))
    config = "\n".join(
        [
            "ListenAddress 127.0.0.1",
            f"Port {args.local_port}",
            f'HostKey "{base}/host-key"',
            f'AuthorizedKeysFile "{base}/authorized_keys"',
            f'PidFile "{base}/sshd.pid"',
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "UsePAM no",
            "StrictModes yes",
            "PermitRootLogin no",
            f"AllowUsers {os.environ['USER']}",
            "",
        ]
    )
    save(base / "sshd_config", config)
    subprocess.run([sshd, "-t", "-f", str(base / "sshd_config")], check=True)
    entry = shlex.join(
        [
            cloud["node"],
            str(Path(info["base"]) / "dsh-entry.mjs"),
            "--state",
            str(Path(info["base"]) / "dsh-state"),
            "--machine",
            args.machine,
        ]
    )
    options = f'restrict,port-forwarding,permitopen="127.0.0.1:3080",permitlisten="127.0.0.1:{args.cloud_port}",command="{entry.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"'
    python_run(
        cloud,
        AUTHORIZE,
        {
            "public": (base / "cloud-entry-key.pub").read_text().strip(),
            "options": options,
        },
    )
    connection = {
        **cloud,
        "identity_file": str(base / "cloud-entry-key"),
        "known_hosts_file": str(base / "cloud-known_hosts"),
    }
    reverse = [
        "ssh",
        *ssh_args(connection),
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        f"127.0.0.1:{args.cloud_port}:127.0.0.1:{args.local_port}",
        cloud["host"],
    ]
    units = Path.home() / ".config/systemd/user"
    save(
        units / "remote-dsh-device-sshd.service",
        unit(
            "Private SSH tool endpoint for remote DSH",
            [sshd, "-D", "-e", "-f", str(base / "sshd_config")],
        ),
    )
    save(
        units / "remote-dsh-device-link.service",
        unit("Remote DSH reverse device link", reverse),
    )
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(
        [
            "systemctl",
            "--user",
            "enable",
            "--now",
            "remote-dsh-device-sshd.service",
            "remote-dsh-device-link.service",
        ],
        check=True,
    )
    # The target bootstrap receives an executable npm path, not a shell command.
    npm_source = ROOT / ".local/npm-clean/package"
    if npm_source.exists():
        npm_runtime = base / "npm-runtime"
        shutil.copytree(npm_source, npm_runtime, dirs_exist_ok=True)
        save(
            base / "npm",
            f'#!/bin/sh\nexec {shlex.quote(node)} {shlex.quote(str(npm_runtime / "bin/npm-cli.js"))} "$@"\n',
            0o755,
        )
        npm = str(base / "npm")
    else:
        npm = shutil.which("npm")
        if not npm:
            raise ValueError("npm is required for the target tool runtime")
    host_public = (base / "host-key.pub").read_text().split()
    target = {
        "host": f"{os.environ['USER']}@127.0.0.1",
        "port": args.cloud_port,
        "identity_file": info["toolKey"],
        "known_hosts_file": str(Path(info["base"]) / f"{args.machine}-known_hosts"),
        "node": node,
        "npm": npm,
        "python": shutil.which("python3"),
        "npm_registry": "https://registry.npmjs.org",
        "remote_base": str(base / "worker"),
        "workspace": str(Path.cwd()),
        "label": args.label
        or ("当前电脑" if args.machine == "desktop" else args.machine),
    }
    update = """import fcntl,json,pathlib,sys
p=json.load(sys.stdin);b=pathlib.Path(p['base']);f=b/'dsh-targets.json'
with (b/'dsh-targets.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX);data=json.loads(f.read_text());data['targets'][p['machine']]=p['target'];temp=f.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2));temp.chmod(0o600);temp.replace(f);k=pathlib.Path(p['target']['known_hosts_file']);k.write_text(p['known']);k.chmod(0o600)
"""
    python_run(
        cloud,
        update,
        {
            "base": info["base"],
            "machine": args.machine,
            "target": target,
            "known": f"[127.0.0.1]:{args.cloud_port} {host_public[0]} {host_public[1]}\n",
        },
    )
    profile = {
        "machine": args.machine,
        "cloud": {
            "host": cloud["host"],
            "port": cloud["port"],
            "identity_file": str(base / "cloud-entry-key"),
            "known_hosts_file": str(base / "cloud-known_hosts"),
            "base": info["base"],
            "node": cloud["node"],
            "webPort": 3080,
        },
    }
    save(base / "client.json", json.dumps(profile, indent=2))
    subprocess.run(
        [
            shutil.which("python3"),
            str(ROOT / "install-dsh-client.py"),
            "--profile",
            str(base / "client.json"),
            "--node",
            node,
            "--bin-dir",
            str(args.bin_dir),
        ],
        check=True,
    )
    print(f"Registered {args.machine}. Use dsh web --remote in any existing directory.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--machine", default="desktop")
    parser.add_argument("--label")
    parser.add_argument("--local-port", type=int, default=22222)
    parser.add_argument("--cloud-port", type=int, default=42022)
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    setup(parser.parse_args())
