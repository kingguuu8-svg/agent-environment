"""An isolated loopback SSH target; never edits the machine's real sshd config."""

import json
import os
import pwd
import shutil
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class SSHFixture:
    def __init__(self):
        self.run_id = uuid.uuid4().hex[:12]
        self.directory = ROOT / ".local" / self.run_id
        self.directory.mkdir(parents=True, mode=0o700)
        self.port = free_port()
        self.user = pwd.getpwuid(os.getuid()).pw_name
        self.process = None
        self.log = None
        self.target_root = Path.home() / ".cache/remote-mcp-demo-tests" / self.run_id
        self.target_root.mkdir(parents=True, mode=0o700)
        self.config = self.directory / "targets.json"

    def __enter__(self):
        try:
            for name in ("host_key", "client_key", "denied_key"):
                subprocess.run(
                    [
                        "ssh-keygen",
                        "-q",
                        "-t",
                        "ed25519",
                        "-N",
                        "",
                        "-f",
                        str(self.directory / name),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
            config = self.directory / "sshd_config"
            config.write_text(
                f"Port {self.port}\nListenAddress 127.0.0.1\n"
                f'HostKey "{self.directory / "host_key"}"\n'
                f'AuthorizedKeysFile "{self.directory / "client_key.pub"}"\n'
                f'PidFile "{self.directory / "sshd.pid"}"\n'
                f"AllowUsers {self.user}\n"
                "StrictModes no\nUsePAM no\nPasswordAuthentication no\n"
                "KbdInteractiveAuthentication no\nPubkeyAuthentication yes\n"
                "AuthenticationMethods publickey\nPermitRootLogin no\nLogLevel ERROR\n"
            )
            self.log = (self.directory / "sshd.log").open("w")
            self.process = subprocess.Popen(
                [shutil.which("sshd"), "-D", "-e", "-f", str(config)],
                stdout=self.log,
                stderr=self.log,
            )
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError((self.directory / "sshd.log").read_text())
                try:
                    with socket.create_connection(
                        ("127.0.0.1", self.port), timeout=0.2
                    ):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("The isolated SSH listener did not start")
            known_hosts = self.directory / "known_hosts"
            known_hosts.write_text(self.known_host(self.port))
            target = {
                "host": f"{self.user}@127.0.0.1",
                "port": self.port,
                "identity_file": str(self.directory / "client_key"),
                "known_hosts_file": str(known_hosts),
                "python": sys.executable,
                "remote_base": str(self.target_root / "bundle"),
                "workspace": str(self.target_root / "workspace"),
            }
            denied = {**target, "identity_file": str(self.directory / "denied_key")}
            self.config.write_text(
                json.dumps({"targets": {"laptop": target, "denied": denied}}, indent=2)
            )
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def known_host(self, port: int) -> str:
        key = (self.directory / "host_key.pub").read_text().split()
        return f"[127.0.0.1]:{port} {key[0]} {key[1]}\n"

    def __exit__(self, *args):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        if self.log:
            self.log.close()
        shutil.rmtree(self.target_root, ignore_errors=True)
        shutil.rmtree(self.directory, ignore_errors=True)
