"""Carry MCP stdio unchanged over an authenticated device bridge connection."""

import argparse
import json
import socket
import sys
import threading
from pathlib import Path


def run(config):
    with socket.create_connection(
        ("127.0.0.1", config["port"]), timeout=10
    ) as connection:
        connection.settimeout(None)
        connection.sendall(
            json.dumps(
                {
                    "token": config["token"],
                    "action": "worker",
                    "workspace": config["workspace"],
                }
            ).encode()
            + b"\n"
        )
        incoming = connection.makefile("rb")
        response = json.loads(incoming.readline(65536))
        if not response["ok"]:
            raise RuntimeError(response["error"])

        def send():
            try:
                while chunk := sys.stdin.buffer.read1(65536):
                    connection.sendall(chunk)
                connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        threading.Thread(target=send, daemon=True).start()
        while chunk := incoming.read1(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-file", type=Path, required=True)
    args = parser.parse_args()
    run(json.loads(args.connection_file.read_text()))
