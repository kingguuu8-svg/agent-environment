"""Verify restored workspace generations through isolated, real loopback SSH."""

import argparse
import json
import subprocess
import sys

from ssh_fixture import ROOT, SSHFixture


def verify(args):
    with SSHFixture(node=args.node, npm=args.npm) as ssh:
        workspace = ssh.target_root / "接续项目 with spaces"
        workspace.mkdir()
        result = subprocess.run(
            [args.node, str(ROOT / "verify_environment_recovery.mjs"), "--fixture"],
            input=json.dumps(
                {
                    "config": str(ssh.config),
                    "machine": "laptop",
                    "workspace": str(workspace),
                    "python": sys.executable,
                }
            ),
            text=True,
            capture_output=True,
            timeout=180,
            cwd=ROOT,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        report = json.loads(
            (ROOT / ".local/verification-environment-recovery-ssh.json").read_text()
        )
        assert report["actualSSH"] and report["nativePiTools"]
        assert len(report["checks"]) == 10 and report["modelRequests"] == 0
        print(result.stdout, end="", flush=True)
    print("PASS isolated SSH, Pi workers and temporary target were cleaned.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True)
    parser.add_argument("--npm", required=True)
    verify(parser.parse_args())
