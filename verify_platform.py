"""Verify portable initialization, standalone HTTP/MCP and optional native DSH."""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def verify(args):
    checks = []

    def passed(name):
        checks.append(name)
        print(f"PASS {name}", flush=True)

    with tempfile.TemporaryDirectory(prefix="platform % 空间-") as temporary, SSHFixture(node=args.node, npm=args.npm) as first, SSHFixture(node=args.node, npm=args.npm) as second:
        base = Path(temporary)
        workspace = base / "host workspace"
        workspace.mkdir()
        (workspace / "identity.txt").write_text("HOST\n")
        for ssh, marker in [(first, "FIRST"), (second, "SECOND")]:
            (ssh.target_root / "project").mkdir()
            (ssh.target_root / "project/identity.txt").write_text(marker + "\n")
            (ssh.target_root / "project/AGENTS.md").write_text(marker + "-PROJECT-INSTRUCTIONS\n")
        targets = base / "target-input.json"
        first_target = json.loads(first.config.read_text())["targets"]["laptop"]
        second_target = json.loads(second.config.read_text())["targets"]["laptop"]
        # Relative key references must survive copying configuration into runtime.
        first_target["identity_file"] = os.path.relpath(first_target["identity_file"], base)
        targets.write_text(json.dumps({"targets": {"first": first_target, "second": second_target}}))
        runtime = base / "runtime"
        port = free_port()

        def cli(command, *options, expected=0, directory=runtime, environment=None):
            result = subprocess.run([sys.executable, str(ROOT / "agent_environment.py"), command, "--directory", str(directory), *map(str, options)],
                                    capture_output=True, text=True, env=environment, timeout=90)
            assert result.returncode == expected, result.stdout + result.stderr
            return result

        init = cli("init", "--workspace", workspace, "--targets", targets, "--node", args.node, "--python", sys.executable,
                   "--port", port, "--web-port", free_port(), "--label", "My server")
        connection_text = (runtime / "connection.md").read_text()
        connection = json.loads(connection_text.split("```json\n", 1)[1].split("\n```", 1)[0])
        assert connection["key"] not in init.stdout + init.stderr
        assert all((runtime / name).stat().st_mode & 0o777 == 0o600 for name in ["platform.json", "dsh-targets.json", "environment-access.json", "connection.md"])
        assert runtime.stat().st_mode & 0o777 == 0o700
        assert load(runtime / "dsh-targets.json")["targets"]["first"]["identity_file"] == str(first.directory / "client_key")
        originals = {p.name: p.read_bytes() for p in runtime.iterdir() if p.is_file()}
        cli("init", "--workspace", workspace, expected=1)
        cli("start", "--workspace", base / "wrong-target", expected=2)
        assert originals == {p.name: p.read_bytes() for p in runtime.iterdir() if p.is_file()}
        passed("private initialization preserves SSH paths, prints no key and refuses to overwrite state")

        for options in [["--url", "http://public.example/"], ["--url", "https://user:password@example.org/"],
                        ["--url", "https://example.org/private"], ["--url", "http://127.0.0.1:1/"],
                        ["--account", "../owner"], ["--mode", "dsh"], ["--workspace", base / "missing"]]:
            rejected = base / "invalid"
            cli("init", "--workspace", workspace, *options, directory=rejected, expected=1)
            assert not rejected.exists()
        passed("invalid origins, accounts, workspaces and missing DSH models leave no partial runtime")
        cli("doctor")
        cli("service")
        unit = (runtime / "agent-environment.service").read_text()
        assert "%%" in unit and f"WorkingDirectory={str(ROOT).replace(chr(37), chr(37) * 2)}" in unit
        assert connection["key"] not in unit
        if shutil.which("systemd-analyze"):
            checked = subprocess.run(["systemd-analyze", "--user", "verify", str(runtime / "agent-environment.service")], capture_output=True)
            assert checked.returncode == 0, checked.stderr.decode()
        passed("model-free diagnostics and escaped user service generation use no personal profile")

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        authorization = "Basic " + base64.b64encode(f"{connection['account']}:{connection['key']}".encode()).decode()

        def post(value, expected=200, auth=authorization):
            request = urllib.request.Request(connection["url"] + "api/environment", data=json.dumps(value).encode(),
                                             headers={"Content-Type": "application/json", "Authorization": auth})
            try:
                response = opener.open(request, timeout=300)
            except urllib.error.HTTPError as error:
                response = error
            assert response.code == expected
            return json.loads(response.read())

        def call(target, tool, arguments):
            return post({"action": "call", "target": target, "tool": tool, "args": arguments})

        def text(result):
            return "".join(item["text"] for item in result["result"]["content"] if item["type"] == "text")

        process = None
        log_path = base / "environment.log"
        with log_path.open("w") as log:
            def start():
                nonlocal process
                process = subprocess.Popen([sys.executable, str(ROOT / "agent_environment.py"), "start", "--directory", str(runtime)],
                                           stdout=log, stderr=log, start_new_session=True)
                wait_for(lambda: opener.open(connection["url"], timeout=2).status == 200, timeout=30)

            def stop():
                if process and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=20)

            try:
                start()
                post({"action": "list"}, expected=401, auth="Basic invalid")
                catalog = post({"action": "list"})
                assert next(m for m in catalog["machines"] if m["id"] == "cloud")["label"] == "My server"
                passed("standalone startup exposes owner-selected machine labels and rejects bad credentials")
                remote_ids = []
                for machine, ssh, marker in [("first", first, "FIRST"), ("second", second, "SECOND")]:
                    data = post({"action": "workspace", "machine": machine, "workspace": str(ssh.target_root / "project")})
                    target = data["target"]["id"]
                    remote_ids.append(target)
                    context = post({"action": "context", "target": target})
                    assert context["target"]["machine"] == machine
                    assert any(marker + "-PROJECT-INSTRUCTIONS" in item["content"] for item in context["context"]["agents_files"])
                    assert text(call(target, "read", {"path": "identity.txt"})) == marker + "\n"
                assert text(call("cloud", "read", {"path": "identity.txt"})) == "HOST\n"
                passed("two real SSH endpoints and the host keep distinct workspaces and project context")
                call(remote_ids[0], "write", {"path": "cross-device.txt", "content": "from-first-to-second\n"})
                data = text(call(remote_ids[0], "read", {"path": "cross-device.txt"}))
                call(remote_ids[1], "write", {"path": "cross-device.txt", "content": data})
                assert (second.target_root / "project/cross-device.txt").read_text() == data
                assert not (workspace / "cross-device.txt").exists()
                passed("a cross-device file task uses actual native tools and never writes in the host workspace")
                result = subprocess.run([args.node, str(ROOT / "verify_platform_mcp.mjs")], input=json.dumps({**connection, "target": remote_ids[1]}),
                                        text=True, capture_output=True, cwd=ROOT, timeout=60)
                assert result.returncode == 0, result.stderr
                passed("official MCP client completes discovery, context, tool execution and structured errors without DSH")
                registry = (runtime / "dsh-state/environment.json").read_bytes()
                duplicate = subprocess.run([sys.executable, str(ROOT / "agent_environment.py"), "start", "--directory", str(runtime)], capture_output=True, timeout=10)
                assert duplicate.returncode != 0
                assert (runtime / "dsh-state/environment.json").read_bytes() == registry
                passed("a second registry owner is rejected while the original service remains usable")
                stop()
                start()
                assert text(call(remote_ids[1], "read", {"path": "cross-device.txt"})) == data
                assert connection_text == (runtime / "connection.md").read_text()
                passed("restart restores registered targets and credentials with real target effects preserved")
            except BaseException:
                print(log_path.read_text()[-4000:], file=sys.stderr)
                raise
            finally:
                stop()

        if args.dsh:
            verify_native_dsh(args, base, workspace, targets, first, second, passed)
        report = {"checks": checks, "dsh": args.dsh, "modelRequests": 0}
        (ROOT / ".local").mkdir(exist_ok=True)
        (ROOT / ".local/verification-platform.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"PASS {len(checks)} portable platform checks; zero model requests", flush=True)


def load(path):
    return json.loads(path.read_text())


def verify_native_dsh(args, base, workspace, targets, first, second, passed):
    runtime = base / "dsh runtime"
    port, web_port = free_port(), free_port()
    models = base / "models.json"
    models.write_text(json.dumps({"dsh": {"piAI": {"providers": {"fixture": {"api": "openai-completions", "baseURL": "http://127.0.0.1:1/v1", "apiKeyEnv": "AGENT_MODEL_KEY", "models": [{"id": "portable-fixture", "contextWindow": 128000, "maxTokens": 1024}]}}}, "defaultSelection": {"provider": "fixture", "model": "portable-fixture"}}}))
    command = [sys.executable, str(ROOT / "agent_environment.py")]
    subprocess.run([*command, "init", "--directory", str(runtime), "--workspace", str(workspace), "--mode", "dsh", "--model", str(models),
                    "--targets", str(targets), "--node", args.node, "--python", sys.executable, "--port", str(port), "--web-port", str(web_port)], check=True, capture_output=True)
    environment = {**os.environ, "AGENT_MODEL_KEY": "isolated-fixture"}
    missing = subprocess.run([*command, "doctor", "--directory", str(runtime)], capture_output=True, env={k: v for k, v in os.environ.items() if k != "AGENT_MODEL_KEY"})
    assert missing.returncode != 0 and b"Missing model credential" in missing.stdout
    subprocess.run([*command, "doctor", "--directory", str(runtime)], check=True, capture_output=True, env=environment)
    # Prepare the same separate runtime and verified assets used by new servers.
    options = ["--asset-dir", str(args.asset_dir)] if args.asset_dir else []
    prepared = subprocess.run([*command, "prepare-devices", "--directory", str(runtime), "--ssh-host", f"{first.user}@127.0.0.1",
                              "--ssh-port", str(first.port), "--host-key", str(first.directory / "host_key.pub"), *options],
                              capture_output=True, text=True, timeout=180)
    assert prepared.returncode == 0, prepared.stdout + prepared.stderr
    platform = load(runtime / "device-platform.json")
    assert platform["webPort"] == web_port
    assert platform["toolKey"] == str(runtime / "keys/host-to-devices")
    assert (runtime / "keys/host-to-devices").stat().st_mode & 0o777 == 0o600
    assert f"[127.0.0.1]:{first.port}" in platform["knownHosts"]
    passed("generic onboarding prepares pinned assets, separate runtime sources and the selected Host ports")
    process = None
    with (base / "dsh.log").open("w") as log:
        def start():
            nonlocal process
            (runtime / "dsh-state/web-url.json").unlink(missing_ok=True)
            process = subprocess.Popen([*command, "start", "--directory", str(runtime)], stdout=log, stderr=log, env=environment)
            wait_for(lambda: (runtime / "dsh-state/web-url.json").exists(), timeout=90)
            api = DshApi(load(runtime / "dsh-state/web-url.json")["url"], f"http://127.0.0.1:{web_port}")
            wait_for(lambda: api.remote("catalog", {}), timeout=90)
            return api

        def stop():
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=20)

        try:
            api = start()
            registry = (runtime / "dsh-state/environment.json").read_bytes()
            duplicate = subprocess.run([args.node, str(ROOT / "environment-server.mjs"), "--state", str(runtime / "dsh-state"),
                                        "--workspace", str(workspace), "--targets", str(runtime / "dsh-targets.json"),
                                        "--python", sys.executable, "--access", str(runtime / "environment-access.json")], capture_output=True, timeout=10)
            assert duplicate.returncode != 0
            assert (runtime / "dsh-state/environment.json").read_bytes() == registry
            passed("standalone and DSH Hosts share a single registry ownership lock")
            for machine, ssh in [("first", first), ("second", second)]:
                path = str(ssh.target_root / "project")
                listing = api.remote("browse", {"machine": machine, "path": path})
                assert listing["absolutePath"] == path
                assert any(entry["name"] == "identity.txt" for entry in listing["entries"])
            assert (runtime / "dsh-state/environment.json").read_bytes() == registry
            passed("native DSH directory selection reaches both SSH machines without registering root workspaces")
            catalog = api.rpc("session/modelCatalog", {})
            assert any(group["id"] == "fixture" and any(m["id"] == "portable-fixture" for m in group["models"]) for group in catalog["groups"])
            controller = "portable-" + "a" * 32
            picked = api.remote("pick", {"machine": "first", "workspace": str(first.target_root / "project")})
            created = api.rpc("session/create", {"request": {"cwd": picked["cwd"]}})
            session = created["sessionId"]
            view = api.remote("control", {"sessionId": session, "clientId": controller, "label": "portable verification"})
            assert view["current"]["machine"] == "first"
            # The native switch command keeps history and input ownership.
            switched = api.remote("switch", {"sessionId": session, "machine": "second", "workspace": str(second.target_root / "project"), "clientId": controller, "epoch": view["control"]["epoch"], "revision": view["revision"]})
            assert switched["current"]["machine"] == "second"
            api.remote("saveDraft", {"sessionId": session, "clientId": controller, "epoch": switched["control"]["epoch"], "text": "continue-on-second-device", "attachmentCount": 0, "revision": switched["draft"]["revision"]})
            def durable_sessions():
                return [{"sessionId": item["sessionId"], "cwd": item["cwd"], "projections": {
                    name: item["projections"]["values"].get(name) for name in ["title", "sessionStats", "agentPreset", "modelSelection", "remoteBinding", "remoteController"]
                }} for item in api.rpc("session/list", {"_request": {}})["items"]]
            sessions = durable_sessions()
            subprocess.run([*command, "web", "--directory", str(runtime), "--no-open", "--local-port", "3081"], check=True, capture_output=True)
            assert "127.0.0.1:3081" in (runtime / "web-launch.txt").read_text()
            passed("generic DSH host exposes configured models, creates on one machine and switches to another")
            stop()
            api = start()
            restored = api.remote("get", {"sessionId": session, "clientId": controller})
            assert restored["current"] == switched["current"]
            assert restored["control"]["mine"]
            assert restored["draft"]["text"] == "continue-on-second-device"
            assert durable_sessions() == sessions
            passed("portable DSH restart preserves the native session, execution target, draft and input owner")
        finally:
            stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    parser.add_argument("--dsh", action="store_true")
    parser.add_argument("--asset-dir", type=Path)
    verify(parser.parse_args())
