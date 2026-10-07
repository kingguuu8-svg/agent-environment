"""Build the small device package; credentials are added only when Web issues a pairing."""

import argparse
import base64
import hashlib
import json
import subprocess
from pathlib import Path

from device_installer import download_bytes, fd_archive

FILES = [
    "device_installer.py",
    "install-dsh-client.py",
    "dsh.mjs",
    "dsh-remote.mjs",
    "state-json.mjs",
    "device_bridge.py",
    "device_services.py",
    "device_supervisor.py",
    "bootstrap.py",
]


def bundle(root):
    cache = root / ".local/device-installer-assets"
    cache.mkdir(parents=True, exist_ok=True)
    archives = {}
    for target_os, native_os in [
        ("linux", "linux"),
        ("mac", "darwin"),
        ("windows", "win32"),
    ]:
        archives[target_os] = {}
        for architecture in ["x64", "arm64"]:
            filename, digest = fd_archive(native_os, architecture)
            archive = cache / filename
            data = archive.read_bytes() if archive.exists() else b""
            if hashlib.sha256(data).hexdigest() != digest:
                data = download_bytes(
                    "https://github.com/sharkdp/fd/releases/download/v10.5.0/"
                    + filename,
                    20 * 1024 * 1024,
                )
                if hashlib.sha256(data).hexdigest() != digest:
                    raise RuntimeError("fd 下载校验失败。")
                archive.write_bytes(data)
            archives[target_os][filename + ".b64"] = base64.b64encode(data).decode()
    return {
        "version": 1,
        "files": {name: (root / name).read_text() for name in FILES},
        "archives": archives,
    }


def platform_configuration(cloud):
    from deploy_cloud_vps import known_host
    from gateway import ssh_args

    effective = subprocess.check_output(["ssh", "-G", *ssh_args(cloud)], text=True)
    options = dict(line.split(" ", 1) for line in effective.splitlines() if " " in line)
    resolved = {
        **cloud,
        "host": options["user"] + "@" + options["hostname"],
        "port": int(options["port"]),
    }
    return {
        "host": resolved["host"],
        "port": resolved["port"],
        "knownHosts": known_host(resolved),
        "node": cloud["node"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=Path(".local/device-installer.bundle.json")
    )
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(bundle(Path(__file__).resolve().parent)))
    print(f"Built device package: {args.output.stat().st_size} bytes")
