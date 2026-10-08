#!/usr/bin/env python3
"""Build a checked source archive without Git history or runtime data."""

import argparse
import gzip
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

from check_release import ROOT, check_sources


def build(destination, root=ROOT):
    files = check_sources(root)
    version = json.loads((root / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid source release version")
    name = "dsh-remote-hub-" + version
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / (name + ".tar.gz")
    hashes = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in files if path != "SOURCE_MANIFEST.json"}
    with archive.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w|") as package:
        for path in [*hashes, "SOURCE_MANIFEST.json"]:
            data = json.dumps({"version": 1, "files": hashes}, indent=2).encode() + b"\n" if path == "SOURCE_MANIFEST.json" else (root / path).read_bytes()
            entry = tarfile.TarInfo(name + "/" + path)
            entry.size = len(data)
            entry.mode = 0o755 if path.endswith(".sh") else 0o644
            entry.mtime = 0
            package.addfile(entry, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination / (archive.name + ".sha256")).write_text(f"{digest}  {archive.name}\n")
    return archive, len(hashes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".local/releases")
    args = parser.parse_args()
    try:
        archive, count = build(args.output.resolve())
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release build failed: {error}\n")
    print(f"Built {archive} ({count} source files, {archive.stat().st_size} bytes)\nSHA256: {archive}.sha256")


if __name__ == "__main__":
    main()
