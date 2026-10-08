#!/usr/bin/env python3
"""Check source inputs for private runtime files and recognizable credentials."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_COMPONENTS = {".git", ".local", ".venv", "node_modules", "__pycache__", "keys", "dsh-home", "dsh-state", "dist"}
PRIVATE_NAMES = {"targets.json", "vps-check.json", "platform.json", "dsh-targets.json", "dsh-models.json", "connection.md", "environment-access.json", ".credentials.yaml", "device-platform.json", "device-installer.bundle.json", "web-url.json", "web-launch.txt", "model.env"}
PATTERNS = {
    "private key material": re.compile(r"-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)?\s*PRIVATE KEY-----\s+[A-Za-z0-9+/=]{64,}"),
    "provider credential": re.compile(r"\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b"),
    "Web launch capability": re.compile(r"[?&]token=[A-Za-z0-9_-]{24,}"),
}


def source_files(root=ROOT):
    if (root / ".git").exists():
        result = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root)
        return sorted(set(filter(None, result.decode().split("\0"))))
    manifest = root / "SOURCE_MANIFEST.json"
    if not manifest.is_file():
        raise ValueError("A source checkout or release SOURCE_MANIFEST.json is required")
    files = json.loads(manifest.read_text())["files"]
    for name, digest in files.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or (root / path).is_symlink():
            raise ValueError("Unsafe release manifest entry")
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"{name}: release manifest hash differs")
    return sorted(files)


def issues_for(name, content):
    path = Path(name)
    issues = []
    if path.is_absolute() or ".." in path.parts or PRIVATE_COMPONENTS.intersection(path.parts) or path.name in PRIVATE_NAMES or path.name.startswith(".env") and path.name != ".env.example":
        issues.append("private or unsafe file path")
    for label, pattern in PATTERNS.items():
        if pattern.search(content):
            issues.append(label)
    if path.suffix == ".json" and path.name not in {"package-lock.json", "pi-tools.json"}:
        try:
            value = json.loads(content)

            def inspect(item):
                if isinstance(item, dict):
                    for key, value in item.items():
                        if key in {"key", "apiKey", "password", "token", "privateKey"} and isinstance(value, str) and len(value) >= 24 and not value.startswith(("$", "<")):
                            issues.append("literal credential in JSON")
                        inspect(value)
                elif isinstance(item, list):
                    for value in item:
                        inspect(value)

            inspect(value)
        except json.JSONDecodeError:
            issues.append("invalid JSON")
    return sorted(set(issues))


def check_sources(root=ROOT):
    files = source_files(root)
    failures = []
    for name in files:
        path = root / name
        if Path(name).is_absolute() or ".." in Path(name).parts:
            failures.append(f"{name}: unsafe source path")
            continue
        if path.is_symlink() or not path.is_file():
            failures.append(f"{name}: source input must be a regular file")
            continue
        content = path.read_text(encoding="utf-8")
        failures.extend(f"{name}: {issue}" for issue in issues_for(name, content))
        if path.suffix == ".md":
            for link in re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", content):
                target = urlsplit(link.strip("<>"))
                if target.scheme or not target.path:
                    continue
                relative = unquote(target.path)
                resolved = (path.parent / relative).resolve()
                if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
                    failures.append(f"{name}: missing or external local link {relative}")
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "docs/QUICKSTART.md", "models.example.json"]:
        if name not in files:
            failures.append(f"{name}: missing release input")
    if failures:
        # Report locations/categories only, never the matched secret.
        raise ValueError("\n".join(failures))
    return files


def check_history(root=ROOT):
    commits = subprocess.check_output(["git", "rev-list", "--all"], cwd=root, text=True).splitlines()
    seen = set()
    failures = []
    for commit in commits:
        entries = subprocess.check_output(["git", "ls-tree", "-r", "-z", commit], cwd=root).split(b"\0")
        for entry in filter(None, entries):
            metadata, name = entry.split(b"\t", 1)
            _, kind, digest = metadata.split()
            if kind != b"blob" or digest in seen:
                continue
            seen.add(digest)
            content = subprocess.check_output(["git", "cat-file", "blob", digest], cwd=root).decode("utf-8", errors="replace")
            failures.extend(f"{commit[:8]}:{name.decode()}: {issue}" for issue in issues_for(name.decode(), content))
    if failures:
        raise ValueError("\n".join(failures))
    return len(commits), len(seen)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true")
    args = parser.parse_args()
    try:
        files = check_sources()
        print(f"PASS {len(files)} source files; private paths and recognizable credential patterns checked")
        if args.history:
            commits, blobs = check_history()
            print(f"PASS {commits} commits and {blobs} distinct historical blobs")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Release check failed:\n{error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
