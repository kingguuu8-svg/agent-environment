"""Verify release exclusion, rejection, manifest integrity and reproducibility."""

import hashlib
import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("source_release", ROOT / "scripts/build_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
check = sys.modules["check_release"]


def rejected(operation):
    try:
        operation()
    except ValueError:
        return
    raise AssertionError("An unsafe release input was accepted")


def run():
    assert check.issues_for(".local/connection.md", "")
    assert check.issues_for("keys/device", "")
    assert check.issues_for("../outside", "")
    assert check.issues_for("sample.json", json.dumps({"key": "fixture" * 8}))
    assert check.issues_for("sample.mjs", "sk-" + "a" * 30)
    assert check.issues_for("sample.mjs", "http://example.org/?token=" + "a" * 32)
    assert not check.issues_for("models.example.json", json.dumps({"apiKey": "$AGENT_MODEL_KEY"}))
    print("PASS release gate rejects private paths and credential material while accepting references")
    with tempfile.TemporaryDirectory(prefix="source-release-") as temporary:
        root = Path(temporary) / "source"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        files = {".gitignore": ".local/\n", "LICENSE": "fixture", "THIRD_PARTY_NOTICES.md": "fixture", "README.md": "[quickstart](docs/QUICKSTART.md)\n",
                 "docs/QUICKSTART.md": "fixture", "models.example.json": "{}", "package.json": '{"version":"1.2.3"}'}
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        (root / ".local").mkdir()
        (root / ".local/connection.md").write_text("private runtime material")
        archive, count = release.build(Path(temporary) / "output", root)
        assert count == len(files)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        release.build(archive.parent, root)
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
        with tarfile.open(archive) as package:
            assert all(".local" not in item.name and ".git/" not in item.name and item.isfile() for item in package)
            extracted = Path(temporary) / "extracted"
            package.extractall(extracted, filter="data")
        extracted /= "agent-environment-1.2.3"
        assert check.check_sources(extracted) == sorted(files)
        print("PASS source archives exclude runtime/history, reproduce exactly and verify without Git")
        (extracted / "README.md").write_text("tampered")
        rejected(lambda: check.check_sources(extracted))
        (root / "README.md").write_text("[missing](absent.md)")
        rejected(lambda: release.build(archive.parent, root))
        (root / "README.md").write_text(files["README.md"])
        (root / "escape.txt").symlink_to(root / ".local/connection.md")
        rejected(lambda: release.build(archive.parent, root))
        (root / "escape.txt").unlink()
        (root / "connection.md").write_text("accidentally tracked capability")
        rejected(lambda: release.build(archive.parent, root))
        (root / "connection.md").unlink()
        print("PASS tampered manifests, broken links, source symlinks and accidental private files stop release builds")
    print("PASS 3 source release checks")


if __name__ == "__main__":
    run()
