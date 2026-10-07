"""Install the remote Pi entry point and an SSH profile on a Linux target."""

import argparse
import json
import os
import shlex
import shutil
from pathlib import Path


def install(args):
    root = Path(__file__).resolve().parent
    profile = json.loads(args.profile.read_text())
    if not profile.get("socket") and not profile.get("cloud", {}).get("host"):
        raise ValueError("Profile must contain a cloud SSH host or a local socket")
    node = shutil.which(args.node)
    if node is None:
        raise ValueError(f"Node executable not found: {args.node}")
    args.bin_dir.mkdir(parents=True, exist_ok=True)
    for name in ("pi", "pi-remote"):
        destination = args.bin_dir / name
        marker = "# remote-mcp-demo launcher"
        if destination.exists() and marker not in destination.read_text():
            raise ValueError(
                f"Existing command at {destination}; choose another --bin-dir"
            )
    config = Path.home() / ".config/remote-pi/client.json"
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(json.dumps(profile, indent=2) + "\n")
    for name, script in (("pi", "pi.mjs"), ("pi-remote", "pi-remote.mjs")):
        destination = args.bin_dir / name
        destination.write_text(
            f'#!/bin/sh\n{marker}\nexec {shlex.quote(node)} {shlex.quote(str(root / script))} "$@"\n'
        )
        destination.chmod(0o755)
    print(f"Installed: {args.bin_dir / 'pi'} --remote")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    install(parser.parse_args())
