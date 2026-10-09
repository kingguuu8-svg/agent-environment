"""Exercise directory browsing and stalled-device recovery with real isolated SSH."""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from ssh_fixture import SSHFixture

ROOT = Path(__file__).resolve().parent


def run(args):
    with SSHFixture(node=args.node, npm=args.npm) as ssh, tempfile.TemporaryDirectory(
        prefix="directory-browser-", dir=ROOT / ".local"
    ) as temporary:
        workspace = ssh.target_root / "新工作区 with spaces"
        workspace.mkdir()
        result = subprocess.run(
            [args.node, str(ROOT / "verify_directory_browser.mjs")],
            input=json.dumps({
                "state": temporary,
                "config": str(ssh.config),
                "workspace": str(workspace),
                "bundle": str(ssh.target_root / "bundle"),
                "python": sys.executable,
            }),
            text=True,
            capture_output=True,
            timeout=240,
        )
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        print(result.stdout, end="")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())
