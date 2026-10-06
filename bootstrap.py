"""Executed over SSH: prepare an isolated tool bundle and print its launch info."""

import hashlib
import json
import os
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
    python = base / "venv/bin/python"
    worker = base / "worker.py"
    marker = base / "bundle.sha256"
    version = hashlib.sha256(
        (request["worker_source"] + request["requirement"]).encode()
    ).hexdigest()
    reused = (
        python.exists()
        and worker.exists()
        and marker.exists()
        and marker.read_text() == version
        and worker.read_text() == request["worker_source"]
    )
    if reused:
        reused = (
            subprocess.run(
                [str(python), "-c", "import mcp"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            ).returncode
            == 0
        )
    if not reused:
        if not python.exists():
            subprocess.run(
                [sys.executable, "-m", "venv", str(base / "venv")],
                check=True,
                stdout=sys.stderr,
                timeout=60,
            )
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--quiet",
                "--timeout",
                "15",
                "--retries",
                "1",
                "--index-url",
                request["index_url"],
                request["requirement"],
            ],
            check=True,
            stdout=sys.stderr,
            timeout=150,
        )
        fd, temporary = tempfile.mkstemp(dir=base, prefix=".worker-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(request["worker_source"])
            os.replace(temporary, worker)
        finally:
            Path(temporary).unlink(missing_ok=True)
        marker.write_text(version)
    return {
        "python": str(python),
        "worker": str(worker),
        "workspace": str(workspace),
        "bundle_version": version,
        "reused": reused,
    }


if __name__ == "__main__":
    print(json.dumps(install(json.load(sys.stdin))))
