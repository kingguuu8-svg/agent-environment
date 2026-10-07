"""Verify the cloud owner and remote terminal through a real loopback SSH target."""

import argparse
import fcntl
import json
import os
import pty
import select
import socket
import struct
import subprocess
import termios
import time

from ssh_fixture import ROOT, SSHFixture, free_port
from verify_workspace_local import WORKSPACE_SETUP


def verify_terminal(fixture, args):
    state = fixture.directory / "cloud-state"
    socket = state / "service.sock"
    workspace = fixture.directory / "cloud-workspace"
    target = json.loads(fixture.config.read_text())["targets"]["laptop"]
    profile = fixture.directory / "client.json"
    profile.write_text(
        json.dumps(
            {
                "cloud": {
                    **{
                        key: target[key]
                        for key in [
                            "host",
                            "port",
                            "identity_file",
                            "known_hosts_file",
                            "node",
                        ]
                    },
                    "base": str(ROOT),
                    "socket": str(socket),
                }
            }
        )
    )
    log_path = fixture.directory / "terminal-service.log"
    with log_path.open("w") as log:
        service = subprocess.Popen(
            [
                args.node,
                str(ROOT / "cloud-service.mjs"),
                "--state-dir",
                str(state),
                "--cloud-workspace",
                str(workspace),
                "--agent-dir",
                str(fixture.directory / "pi-agent"),
                "--config",
                str(fixture.config),
            ],
            stdout=log,
            stderr=log,
        )
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 110, 0, 0))
        client = None
        captured = bytearray()

        def receive_until(predicate, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    captured.extend(os.read(master, 65536))
                if predicate():
                    return
                if client is not None and client.poll() is not None:
                    raise RuntimeError(captured.decode(errors="replace")[-3000:])
            raise RuntimeError(
                "Remote terminal verification timed out:\n"
                + captured.decode(errors="replace")[-3000:]
            )

        try:
            for _ in range(100):
                if socket.exists():
                    break
                if service.poll() is not None:
                    raise RuntimeError(log_path.read_text())
                time.sleep(0.05)
            client = subprocess.Popen(
                [
                    args.node,
                    str(ROOT / "pi.mjs"),
                    "--remote",
                    "--config",
                    str(profile),
                    "--workspace-id",
                    "cloud",
                ],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env={**os.environ, "TERM": "xterm-256color"},
            )
            receive_until(lambda: b"Remote Pi" in captured)
            os.write(master, b"!printf UI-PROOF > ui-proof.txt\r")
            receive_until(lambda: (workspace / "ui-proof.txt").exists())
            assert (workspace / "ui-proof.txt").read_text() == "UI-PROOF"
            before = len(captured)
            os.write(master, b"/reconnect\r")
            receive_until(lambda: b"Reconnected to cloud session" in captured[before:])
            before = len(captured)
            os.write(master, b"/takeover\r")
            receive_until(lambda: b"Input control acquired" in captured[before:])
            os.write(master, b"!printf RECONNECTED > reconnect-proof.txt\r")
            receive_until(lambda: (workspace / "reconnect-proof.txt").exists())
            assert (workspace / "reconnect-proof.txt").read_text() == "RECONNECTED"
            before = len(captured)
            os.write(master, b"/workspace\r")
            receive_until(lambda: b"connected" in captured[before:])
            os.write(master, b"\r")
            time.sleep(0.1)
            os.write(master, b"/resume all\r")
            receive_until(
                lambda: b"Resume Session" in captured or b"All sessions" in captured
            )
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"/exit\r")
            assert client.wait(timeout=15) == 0
        finally:
            if client and client.poll() is None:
                client.terminate()
                client.wait(timeout=10)
            os.close(master)
            os.close(slave)
            service.terminate()
            service.wait(timeout=20)
    report_path = ROOT / ".local/verification-cloud-local.json"
    report = json.loads(report_path.read_text())
    report["checks"].append(
        "real SSH PTY renders the Pi editor, reconnects, runs cloud bash, opens the resume selector and detaches"
    )
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print("PASS real Pi terminal components and resume selector", flush=True)


def run(args):
    with SSHFixture(node=args.node, npm=args.npm) as fixture:
        paths = json.loads(
            subprocess.check_output(
                ["python3", "-c", WORKSPACE_SETUP],
                input=json.dumps({"base": str(fixture.target_root / "projects")}),
                text=True,
            )
        )
        port = free_port()
        config = json.loads(fixture.config.read_text())
        config["mcp"] = {"archive": {"url": f"http://127.0.0.1:{port}/mcp"}}
        fixture.config.write_text(json.dumps(config))
        with (fixture.directory / "archive.log").open("w") as log:
            archive = subprocess.Popen(
                [
                    str(ROOT / ".venv/bin/python"),
                    str(ROOT / "workspace_gateway.py"),
                    "--config",
                    str(fixture.config),
                    "--machine",
                    "laptop",
                    "--workspace",
                    paths[0],
                    "--transport",
                    "http",
                    "--port",
                    str(port),
                ],
                stdout=log,
                stderr=log,
            )
            try:
                for _ in range(100):
                    if archive.poll() is not None:
                        raise RuntimeError(
                            (fixture.directory / "archive.log").read_text()
                        )
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Archive MCP endpoint did not start")
                verify(args, fixture, paths)
                verify_terminal(fixture, args)
            finally:
                archive.terminate()
                archive.wait(timeout=15)


def verify(args, fixture, paths):
    subprocess.run(
        [
            args.node,
            str(ROOT / "verify_cloud.mjs"),
            "--config",
            str(fixture.config),
            "--machine",
            "laptop",
            "--workspace-a",
            paths[0],
            "--cloud-workspace",
            str(fixture.directory / "cloud-workspace"),
            "--state-dir",
            str(fixture.directory / "cloud-state"),
            "--agent-dir",
            str(fixture.directory / "pi-agent"),
            "--output",
            str(ROOT / ".local/verification-cloud-local.json"),
        ],
        check=True,
        timeout=300,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())
