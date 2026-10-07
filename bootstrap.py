"""Executed over SSH: prepare an isolated tool bundle and print its launch info."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def install(request: dict) -> dict:
    if sys.version_info < (3, 11):
        raise RuntimeError("This demo requires Python 3.11 or newer on the target")
    home = Path.home()
    base = (home / request["remote_base"]).resolve()
    workspace = (home / request["workspace"]).resolve()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    node = shutil.which(os.path.expanduser(request["node"]))
    npm = shutil.which(os.path.expanduser(request["npm"]))
    if not node or not npm:
        raise RuntimeError(
            "The Pi bundle requires Node.js >=22.19.0 and npm on the target"
        )
    node_version = subprocess.check_output([node, "--version"], text=True).strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", node_version)
    if not match or tuple(map(int, match.groups())) < (22, 19, 0):
        raise RuntimeError(f"Pi requires Node.js >=22.19.0; found {node_version}")
    worker = base / "worker.mjs"
    marker = base / "bundle.sha256"
    files = request["files"]
    if set(files) != {
        "worker.mjs",
        "package.json",
        "package-lock.json",
        "pi-tools.json",
    }:
        raise ValueError("Unexpected files in the Pi bundle")
    version = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    env = {
        **os.environ,
        "PATH": str(Path(node).parent) + os.pathsep + os.environ["PATH"],
    }
    reused = (
        marker.exists()
        and marker.read_text() == version
        and all(
            (base / name).exists() and (base / name).read_text() == content
            for name, content in files.items()
        )
    )
    if reused:
        reused = (
            subprocess.run(
                [node, str(worker), "--check-manifest"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                env=env,
                check=False,
            ).returncode
            == 0
        )
    if not reused:
        for name, content in files.items():
            save(base / name, content)
        subprocess.run(
            [
                npm,
                "ci",
                "--omit=dev",
                "--no-audit",
                "--no-fund",
                "--fetch-timeout=30000",
                "--fetch-retries=1",
                "--registry",
                request["npm_registry"],
            ],
            cwd=base,
            env=env,
            check=True,
            stdout=sys.stderr,
            timeout=210,
        )
        subprocess.run(
            [node, str(worker), "--check-manifest"],
            cwd=base,
            env=env,
            check=True,
            stdout=sys.stderr,
            timeout=20,
        )
        save(marker, version)
    return {
        "node": node,
        "worker": str(worker),
        "workspace": str(workspace),
        "bundle_version": version,
        "reused": reused,
    }


def save(path: Path, content: str) -> None:
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".bundle-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    print(json.dumps(install(json.load(sys.stdin))))
