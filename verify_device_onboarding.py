"""Exercise real pairing files, SSH permissions, concurrency and installer packaging."""

import base64
import concurrent.futures
import copy
import hashlib
import http.server
import io
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
import zlib
from pathlib import Path

from build_device_installer import bundle
from device_installer import download_bytes, fd_archive
from device_onboarding import create, pair, save, status

ROOT = Path(__file__).resolve().parent


def public(base, name):
    path = base / name
    subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path)], check=True
    )
    return " ".join(path.with_suffix(".pub").read_text().split()[:2])


def rejected(operation, text):
    try:
        operation()
    except ValueError as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError("Expected a rejected registration")


def run():
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    with tempfile.TemporaryDirectory(prefix="dsh-onboarding-") as directory:
        base = Path(directory)
        runtime, state, user_home = base / "runtime", base / "state", base / "home"
        runtime.mkdir()
        (runtime / "keys").mkdir()
        tool = public(runtime / "keys", "cloud-to-vps1")
        existing = {
            "targets": {
                "desktop": {"port": 42022, "label": "Existing desktop"},
                "vps1": {"port": 22},
            },
            "mcp": {"notes": {"url": "http://example.invalid/mcp"}},
        }
        save(runtime / "dsh-targets.json", existing)
        save(
            runtime / "device-platform.json",
            {
                "host": "ubuntu@192.0.2.10",
                "port": 22,
                "knownHosts": "test-pin",
                "node": "node",
            },
        )
        save(runtime / "device-installer.bundle.json", bundle(ROOT))
        (user_home / ".ssh").mkdir(parents=True)
        original_auth = "# Preserve the user's existing SSH access\n"
        (user_home / ".ssh/authorized_keys").write_text(original_auth)

        def issue(target_os="linux"):
            before = set((state / "pairing").glob("*"))
            installer = create(runtime, state, user_home, target_os)
            added = set((state / "pairing").glob("*")) - before
            assert len(added) == 1
            return next(iter(added)).name, installer

        token, installer = issue()
        assert installer["pairingId"] == token
        assert 0 < installer["expiresAt"] / 1000 - time.time() <= 900
        assert "__PACKAGE__" not in installer["content"]
        subprocess.run(
            ["bash", "-n"], input=installer["content"], text=True, check=True
        )
        assert not (state / "pairing" / token / "key").exists()
        assert "expiry-time=" in (user_home / ".ssh/authorized_keys").read_text()
        assert len(installer["content"]) < 16 * 1024 * 1024
        packed = re.search(r'base64.b64decode\("([^"]+)"\)', installer["content"])[1]
        unpacked = json.loads(zlib.decompress(base64.b64decode(packed)))
        for architecture in ["x64", "arm64"]:
            filename, digest = fd_archive("linux", architecture)
            assert (
                hashlib.sha256(
                    base64.b64decode(unpacked[filename + ".b64"])
                ).hexdigest()
                == digest
            )
        passed(
            "standalone installer has expiring restricted pairing and no retained cloud private key"
        )
        configuration = (runtime / "dsh-targets.json").read_bytes()
        waiting = status(runtime, state, token)
        assert waiting == {
            "phase": "waiting",
            "platform": "linux",
            "expiresAt": installer["expiresAt"],
        }
        for invalid in [None, 123, [], "../receipt", "A" * 32]:
            rejected(lambda value=invalid: status(runtime, state, value), "Invalid")
        rejected(lambda: status(runtime, state, "0" * 32), "找不到")
        assert (runtime / "dsh-targets.json").read_bytes() == configuration
        passed(
            "installer progress validates identity and reports waiting without exposing pairing credentials or mutating targets"
        )
        sources = bundle(ROOT)["files"]
        assert set(sources) == {
            "device_installer.py",
            "install-dsh-client.py",
            "dsh.mjs",
            "dsh-remote.mjs",
            "state-json.mjs",
            "device_bridge.py",
            "device_services.py",
            "device_supervisor.py",
            "bootstrap.py",
        }
        assert (
            'from "./environment.mjs"'
            not in sources["dsh.mjs"] + sources["dsh-remote.mjs"]
        )
        passed(
            "device package runs without repository, uv, model credentials or agent SDK dependencies"
        )
        attempts = {}

        class DownloadEndpoint(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                attempts[self.path] = attempts.get(self.path, 0) + 1
                data = b"complete-vendor-package"
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.path == "/unavailable" or (
                    self.path == "/retry" and attempts[self.path] == 1
                ):
                    self.wfile.write(data[:2])
                    self.close_connection = True
                else:
                    self.wfile.write(data)

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DownloadEndpoint)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            assert download_bytes(origin + "/retry", 1024) == b"complete-vendor-package"
            assert attempts["/retry"] == 2
            try:
                download_bytes(origin + "/unavailable", 1024)
            except RuntimeError as error:
                assert "重跑安装器" in str(error)
            else:
                raise AssertionError("Unavailable download did not stop")
            assert attempts["/unavailable"] == 3
            rejected(lambda: download_bytes(origin + "/oversize", 2), "超出预期")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        passed(
            "interrupted downloads retry complete bytes, stop after three failures and reject oversized files"
        )
        for target_os in ["mac", "windows"]:
            package = create(runtime, state, user_home, target_os)
            if target_os == "mac":
                subprocess.run(
                    ["bash", "-n"], input=package["content"], text=True, check=True
                )
                assert package["filename"].endswith(".command")
                packed = re.search(
                    r'base64.b64decode\("([^"]+)"\)', package["content"]
                )[1]
                extracted = json.loads(zlib.decompress(base64.b64decode(packed)))
            else:
                assert package["encoding"] == "base64"
                with zipfile.ZipFile(
                    io.BytesIO(base64.b64decode(package["content"]))
                ) as archive:
                    assert set(archive.namelist()) == {
                        "dsh-connect.cmd",
                        "dsh-connect.ps1",
                    }
                    assert (
                        archive.read("dsh-connect.ps1")
                        .decode("utf-8-sig")
                        .startswith("$ErrorActionPreference")
                    )
                    script = archive.read("dsh-connect.ps1").decode("utf-8-sig")
                    assert "& $python -c $decode $temporary $bundle" in script
                    packed = re.search(r"WriteAllText\(\$bundle, '([^']+)'\)", script)[
                        1
                    ]
                    extracted = json.loads(zlib.decompress(base64.b64decode(packed)))
                    assert extracted["pairing.json"]
                    assert all(
                        extracted[name] == source for name, source in sources.items()
                    )
                    code = re.search(r"\$decode = '((?:[^']|'')*)'\n", script)[
                        1
                    ].replace("''", "'")
                    assert (
                        '"' not in code
                    )  # PowerShell 5.1 strips embedded double quotes.
                    destination = base / "Windows extracted package"
                    destination.mkdir()
                    encoded = base / "encoded.txt"
                    encoded.write_text(packed)
                    subprocess.run(
                        [sys.executable, "-c", code, str(destination), str(encoded)],
                        check=True,
                    )
                    assert all(
                        (destination / name).read_text() == content
                        for name, content in extracted.items()
                    )
            native_os = {"mac": "darwin", "windows": "win32"}[target_os]
            expected = set()
            for architecture in ["x64", "arm64"]:
                filename, digest = fd_archive(native_os, architecture)
                expected.add(filename + ".b64")
                assert (
                    hashlib.sha256(
                        base64.b64decode(extracted[filename + ".b64"])
                    ).hexdigest()
                    == digest
                )
            assert {name for name in extracted if name.endswith(".b64")} == expected
        rejected(lambda: create(runtime, state, user_home, "invalid"), "Choose")
        passed(
            "Linux, macOS and Windows packages contain their own startup scripts; invalid OS is rejected"
        )

        entry, host = public(base, "entry"), public(base, "host")
        request = {
            "entryPublicKey": entry,
            "hostPublicKey": host,
            "user": "tester",
            "hostname": "Laptop",
            "label": "笔记本",
            "node": "/usr/bin/node",
            "npm": "/home/tester/npm",
            "python": "/usr/bin/python3",
            "workerRoot": "/home/tester/worker",
            "workspace": "/home/tester/My Project",
            "localPort": 22222,
        }
        before = (runtime / "dsh-targets.json").read_bytes()
        for invalid in [
            {**request, "entryPublicKey": "ssh-ed25519 invalid"},
            {**request, "user": "bad user"},
            {**request, "node": "node\nother"},
            {**request, "localPort": 22},
            {**request, "hostname": "line\nbreak"},
        ]:
            try:
                pair(runtime, state, user_home, token, invalid)
            except (ValueError, __import__("binascii").Error):
                pass
            else:
                raise AssertionError("Malformed registration was accepted")
            assert (runtime / "dsh-targets.json").read_bytes() == before
        passed(
            "invalid key, user, path, port and hostname leave existing targets unchanged"
        )

        first = pair(runtime, state, user_home, token, copy.deepcopy(request))
        again = pair(runtime, state, user_home, token, copy.deepcopy(request))
        assert first == again and first["toolPublicKey"] == tool
        configuration = json.loads((runtime / "dsh-targets.json").read_text())
        assert len(configuration["targets"]) == 3
        assert configuration["mcp"] == existing["mcp"]
        assert configuration["targets"]["desktop"] == existing["targets"]["desktop"]
        assert first["cloudPort"] != 42022
        known = Path(configuration["targets"][first["machine"]]["known_hosts_file"])
        assert host in known.read_text() and known.stat().st_mode & 0o777 == 0o600
        auth = (user_home / ".ssh/authorized_keys").read_text()
        assert (
            auth.startswith(original_auth)
            and auth.count("remote-dsh-device-" + first["machine"]) == 1
        )
        assert f'permitlisten="127.0.0.1:{first["cloudPort"]}"' in auth
        passed(
            "successful registration and repeated claim preserve existing devices and exact SSH permissions"
        )
        receipt_path = state / "pairing" / token / "receipt.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["complete"] = False
        save(receipt_path, receipt)
        assert status(runtime, state, token)["phase"] == "registering"
        assert "machine" not in status(runtime, state, token)
        receipt["complete"] = True
        receipt["expiresAt"] = int(time.time()) - 1
        save(receipt_path, receipt)
        registered_status = status(runtime, state, token)
        assert registered_status["phase"] == "registered"
        assert registered_status["machine"] == {
            "id": first["machine"],
            "label": request["label"],
            "workspace": request["workspace"],
        }
        wire = json.loads(
            subprocess.check_output(
                [
                    sys.executable,
                    str(ROOT / "device_onboarding.py"),
                    "status",
                    "--runtime",
                    str(runtime),
                    "--state",
                    str(state),
                    "--pairing",
                    token,
                ]
            )
        )
        assert wire == registered_status
        receipt["expiresAt"] = installer["expiresAt"] / 1000
        save(receipt_path, receipt)
        passed(
            "partial claims stay registering and completed registration remains available after installer expiry through the CLI"
        )
        rejected(
            lambda: pair(
                runtime,
                state,
                user_home,
                token,
                {**request, "entryPublicKey": public(base, "other-entry")},
            ),
            "另一台设备",
        )
        passed("one installer cannot register a different device")

        token2, _ = issue()
        token3, _ = issue()
        request2, request3 = (
            {**request, "entryPublicKey": public(base, "entry2")},
            {**request, "entryPublicKey": public(base, "entry3")},
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(
                pool.map(
                    lambda params: pair(runtime, state, user_home, *params),
                    [(token2, request2), (token2, request2), (token3, request3)],
                )
            )
        assert results[0] == results[1]
        assert results[0]["cloudPort"] != results[2]["cloudPort"]
        assert (
            len(json.loads((runtime / "dsh-targets.json").read_text())["targets"]) == 5
        )
        passed(
            "concurrent registrations and duplicate requests allocate unique identities and ports"
        )

        token4, _ = issue()
        receipt_path = state / "pairing" / token4 / "receipt.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["expiresAt"] = int(time.time()) - 1
        save(receipt_path, receipt)
        before = (runtime / "dsh-targets.json").read_bytes()
        assert status(runtime, state, token4)["phase"] == "expired"
        rejected(
            lambda: pair(runtime, state, user_home, token4, copy.deepcopy(request)),
            "已过期",
        )
        assert before == (runtime / "dsh-targets.json").read_bytes()
        issue()
        assert (
            "remote-dsh-pair-" + token4
            not in (user_home / ".ssh/authorized_keys").read_text()
        )
        passed(
            "expired installers fail before registration and their SSH authorization is pruned"
        )

        # Resume the exact claim after a partial cloud write, as if the process
        # stopped after reserving identity but before publishing its target.
        config = json.loads((runtime / "dsh-targets.json").read_text())
        config["targets"].pop(results[2]["machine"])
        save(runtime / "dsh-targets.json", config)
        recovered = pair(runtime, state, user_home, token3, copy.deepcopy(request3))
        assert recovered == results[2]
        passed("partial registration and lost response recover using the same identity")

        recovery_token, _ = issue()
        configuration = (runtime / "dsh-targets.json").read_bytes()
        recovered = pair(
            runtime, state, user_home, recovery_token, copy.deepcopy(request3)
        )
        assert recovered == results[2]
        assert (runtime / "dsh-targets.json").read_bytes() == configuration
        passed(
            "a fresh pairing package recovers an already registered device after a lost response and expiry"
        )

        bridge_token, _ = issue()
        bridge_request = {
            **request,
            "entryPublicKey": public(base, "bridge-entry"),
            "kind": "bridge",
            "platform": "linux",
            "token": "a" * 64,
        }
        before = (runtime / "dsh-targets.json").read_bytes()
        for invalid in [
            {**bridge_request, "token": "short"},
            {**bridge_request, "token": None},
            {**bridge_request, "kind": "unknown"},
        ]:
            rejected(
                lambda: pair(runtime, state, user_home, bridge_token, invalid),
                "Invalid",
            )
            assert before == (runtime / "dsh-targets.json").read_bytes()
        rejected(
            lambda: pair(
                runtime,
                state,
                user_home,
                bridge_token,
                {**bridge_request, "platform": "windows"},
            ),
            "不匹配",
        )
        connected = pair(
            runtime, state, user_home, bridge_token, copy.deepcopy(bridge_request)
        )
        assert connected == pair(
            runtime, state, user_home, bridge_token, copy.deepcopy(bridge_request)
        )
        configuration = json.loads((runtime / "dsh-targets.json").read_text())
        registered = configuration["targets"][connected["machine"]]
        assert registered["kind"] == "bridge" and registered["token"] == "a" * 64
        assert (
            "identity_file" not in registered and "known_hosts_file" not in registered
        )
        assert not (runtime / (connected["machine"] + "-known_hosts")).exists()
        passed(
            "bridge registration validates transport, platform and token and works without device SSH server"
        )

        windows_token, _ = issue("windows")
        windows_request = {
            **bridge_request,
            "entryPublicKey": public(base, "windows-entry"),
            "platform": "windows",
            "node": r"C:\Users\tester\App Data\node.exe",
            "npm": r"C:\Users\tester\App Data\npm-cli.js",
            "python": r"C:\Users\tester\Python\python.exe",
            "workerRoot": r"C:\Users\tester\worker",
            "workspace": r"D:\项目\My Project",
        }
        connected = pair(
            runtime, state, user_home, windows_token, copy.deepcopy(windows_request)
        )
        registered = json.loads((runtime / "dsh-targets.json").read_text())["targets"][
            connected["machine"]
        ]
        assert registered["workspace"] == windows_request["workspace"]
        assert (
            registered["node"] == windows_request["node"]
            and registered["platform"] == "windows"
        )
        rejected(
            lambda: pair(
                runtime,
                state,
                user_home,
                windows_token,
                {**windows_request, "workspace": "D:relative"},
            ),
            "Invalid device path",
        )
        passed(
            "Windows drive paths, Unicode and spaces survive registration; relative drive paths are rejected"
        )

        boundary_token, _ = issue()
        boundary = pair(
            runtime,
            state,
            user_home,
            boundary_token,
            {
                **bridge_request,
                "entryPublicKey": public(base, "boundary-entry"),
                "hostname": "abcdefghijklmno-x",
            },
        )
        assert "__" not in boundary["machine"] and len(boundary["machine"]) <= 32
        passed(
            "long hostnames ending at a separator produce a valid gateway machine identity"
        )
    report = ROOT / ".local/verification-device-onboarding.json"
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps({"checks": checks}, ensure_ascii=False, indent=2))
    print(f"Verified {len(checks)} device onboarding checks")


if __name__ == "__main__":
    run()
