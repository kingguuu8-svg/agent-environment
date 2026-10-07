"""Install the remote DSH entry while preserving an existing ordinary DSH command."""

import argparse
import json
import os
import shlex
import shutil
from pathlib import Path


def install(args):
    root = Path(__file__).resolve().parent
    profile = json.loads(args.profile.read_text())
    if not profile.get("localState") and not profile.get("cloud", {}).get("host"):
        raise ValueError("Profile needs a cloud SSH host or local DSH state")
    node = shutil.which(args.node)
    if not node:
        raise ValueError("Node.js is required")
    args.bin_dir.mkdir(parents=True, exist_ok=True)
    destination = args.bin_dir / "dsh"
    marker = "# remote-dsh launcher"
    if destination.exists() and marker not in destination.read_text():
        backup = args.bin_dir / ".dsh-before-remote"
        if backup.exists():
            raise ValueError(
                "An earlier DSH backup exists; inspect it before replacing"
            )
        shutil.copy2(destination, backup)
        profile["nativeCommand"] = [str(backup)]
    config = Path.home() / ".config/remote-dsh/client.json"
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if config.exists() and "nativeCommand" not in profile:
        previous = json.loads(config.read_text())
        if "nativeCommand" in previous:
            profile["nativeCommand"] = previous["nativeCommand"]
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(json.dumps(profile, indent=2) + "\n")
    # Unlink a symlink so installation cannot overwrite the upstream package.
    if destination.is_symlink():
        destination.unlink()
    destination.write_text(
        f'#!/bin/sh\n{marker}\nexec {shlex.quote(node)} {shlex.quote(str(root / "dsh.mjs"))} "$@"\n'
    )
    destination.chmod(0o755)
    print(f"Installed: {destination} web --remote")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    install(parser.parse_args())
