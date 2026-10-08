"""Inspect actual model HTTP requests before and after native workspace switches."""

import argparse
import array
import concurrent.futures
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import termios
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ssh_fixture import SSHFixture, free_port
from verify_dsh import DshApi, wait_for

ROOT = Path(__file__).resolve().parent


def run(args):
    run_id = uuid.uuid4().hex[:12]
    base = ROOT / ".local" / ("dsh-context-" + run_id)
    cloud = base / "cloud"
    cloud.mkdir(parents=True, mode=0o700)
    cloud_marker, remote_marker = "CLOUD-" + run_id, "REMOTE-" + run_id
    (cloud / "AGENTS.md").write_text(
        cloud_marker + "\nKeep {{cloud-template}} literal.\n"
    )
    requests = []
    running_marker = "HANDOFF-RUNNING-" + run_id
    release_turn = threading.Event()
    held_turn_started = threading.Event()

    class Recorder(BaseHTTPRequestHandler):
        def log_message(self, *arguments):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            if (
                any(
                    message["role"] == "user"
                    and running_marker in str(message["content"])
                    for message in payload["messages"]
                )
                and not release_turn.is_set()
            ):
                held_turn_started.set()
                if not release_turn.wait(timeout=30):
                    raise RuntimeError("Held handoff turn was not released")
            chunks = [
                {
                    "delta": {"role": "assistant", "content": "CONTEXT-WIRE-OK"},
                    "finish_reason": None,
                },
                {"delta": {}, "finish_reason": "stop"},
            ]
            last_user = max(
                i
                for i, message in enumerate(payload["messages"])
                if message["role"] == "user"
            )
            if "DETACHED-CLOUD" in str(payload["messages"][last_user]["content"]):
                calls = [
                    call
                    for message in payload["messages"][last_user + 1 :]
                    for call in message.get("tool_calls", [])
                ]
                if not calls:
                    chunks = [
                        {
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "detached-" + uuid.uuid4().hex,
                                        "type": "function",
                                        "function": {
                                            "name": "environment",
                                            "arguments": json.dumps(
                                                {
                                                    "action": "call",
                                                    "target": "cloud",
                                                    "tool": "read",
                                                    "args": {"path": "AGENTS.md"},
                                                }
                                            ),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": None,
                        },
                        {"delta": {}, "finish_reason": "tool_calls"},
                    ]
            body = (
                "".join(
                    "data: "
                    + json.dumps(
                        {
                            "id": "chatcmpl-context-" + run_id,
                            "object": "chat.completion.chunk",
                            "created": 1,
                            "model": "context-fixture",
                            "choices": [{"index": 0, **chunk}],
                        }
                    )
                    + "\n\n"
                    for chunk in chunks
                )
                + "data: [DONE]\n\n"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body.encode())))
            self.end_headers()
            self.wfile.write(body.encode())

    recorder = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=recorder.serve_forever, daemon=True)
    thread.start()
    host = None
    checks = []
    detached_timings = {}

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    try:
        with SSHFixture(node=args.node, npm=args.npm) as fixture:
            remote = fixture.target_root / "workspace"
            remote.mkdir()
            instructions = remote / "AGENTS.md"
            instructions.write_text(
                remote_marker + "\nKeep {{remote-template}} literal.\n"
            )
            subprocess.run(
                [
                    "git",
                    "init",
                    "--quiet",
                    "--initial-branch=context-fixture",
                    str(remote),
                ],
                check=True,
            )
            subprocess.run(["git", "-C", str(remote), "add", "AGENTS.md"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(remote),
                    "-c",
                    "user.name=Context fixture",
                    "-c",
                    "user.email=context@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--quiet",
                    "-m",
                    "Fixture instructions",
                ],
                check=True,
            )
            configuration = json.loads(fixture.config.read_text())
            configuration["targets"]["slow"] = dict(configuration["targets"]["laptop"])
            fixture.config.write_text(json.dumps(configuration))
            models = base / "models.json"
            models.write_text(
                json.dumps(
                    {
                        "providers": {
                            "fixture": {
                                "baseUrl": f"http://127.0.0.1:{recorder.server_port}/v1",
                                "api": "openai-completions",
                                "models": [
                                    {
                                        "id": "context-fixture",
                                        "reasoning": False,
                                        "contextWindow": 128000,
                                        "maxTokens": 1024,
                                        "compat": {
                                            "supportsDeveloperRole": False,
                                            "supportsStore": False,
                                        },
                                    }
                                ],
                            }
                        }
                    }
                )
            )
            subprocess.run(
                [
                    args.node,
                    str(ROOT / "configure-dsh.mjs"),
                    "--home",
                    str(base / "home"),
                    "--state",
                    str(base / "state"),
                    "--workspace",
                    str(cloud),
                    "--targets",
                    str(fixture.config),
                    "--python",
                    sys.executable,
                    "--model",
                    str(models),
                ],
                check=True,
            )
            with (base / "runtime.log").open("w") as log:
                host = subprocess.Popen(
                    [
                        args.node,
                        str(ROOT / "dsh-host.mjs"),
                        "--home",
                        str(base / "home"),
                        "--state",
                        str(base / "state"),
                        "--workspace",
                        str(cloud),
                        "--port",
                        str(free_port()),
                    ],
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                    env={
                        **os.environ,
                        "REMOTE_MCP_CHECK_API_KEY": "context-fixture-key",
                    },
                )

                def login():
                    launch = base / "state/web-url.json"
                    if not launch.exists():
                        raise RuntimeError("DSH context fixture is starting")
                    return DshApi(json.loads(launch.read_text())["url"])

                api = wait_for(login, timeout=30)
                wait_for(lambda: api.remote("catalog", {}), timeout=30)
                picked = api.remote(
                    "pick", {"machine": "cloud", "workspace": str(cloud)}
                )
                expected_title = f"{socket.gethostname()} · {cloud.name}"
                assert picked["title"] == expected_title
                registered = api.rpc(
                    "workspace/create", {"request": {"path": picked["cwd"]}}
                )
                assert (
                    registered["workspace"]["title"] == expected_title
                    and not registered["created"]
                )
                passed(
                    "workspace selection registers a complete host-and-folder name before returning"
                )
                api.rpc(
                    "workspace/rename",
                    {
                        "request": {
                            "workspaceId": picked["workspaceId"],
                            "title": Path(picked["cwd"]).name,
                        }
                    },
                )
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    repeated = list(
                        pool.map(
                            lambda _: api.remote(
                                "pick", {"machine": "cloud", "workspace": str(cloud)}
                            ),
                            range(3),
                        )
                    )
                assert all(
                    value["workspaceId"] == picked["workspaceId"]
                    and value["title"] == expected_title
                    for value in repeated
                )
                passed(
                    "repeated parallel selection reuses the workspace and repairs a partial legacy name"
                )
                session = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": picked["workspaceId"]}},
                )["sessionId"]
                client = str(uuid.uuid4())
                control = api.remote(
                    "control", {"sessionId": session, "clientId": client}
                )
                epoch = control["control"]["epoch"]

                def get():
                    return api.remote("get", {"sessionId": session, "clientId": client})

                def prompt():
                    count = len(requests)
                    api.remote(
                        "input",
                        {
                            "clientId": client,
                            "epoch": epoch,
                            "method": "prompt",
                            "payload": {
                                "sessionId": session,
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [
                                    {
                                        "type": "text",
                                        "text": "Reply exactly CONTEXT-WIRE-OK. Do not use tools.",
                                    }
                                ],
                            },
                        },
                    )
                    wait_for(lambda: len(requests) > count, timeout=30)
                    wait_for(get, lambda value: not value["running"], timeout=30)
                    assert len(requests) == count + 1, "Unexpected model retry"
                    body = requests[-1]
                    systems = [
                        m["content"]
                        for m in body["messages"]
                        if m["role"] in {"system", "developer"}
                    ]
                    assert len(systems) == 1, "Expected one effective system prompt"
                    assert isinstance(systems[0], str)
                    assert (
                        "Current execution environment (authoritative for this request):"
                        in systems[0]
                    )
                    return systems[0]

                def switch(machine, workspace):
                    return api.remote(
                        "switch",
                        {
                            "sessionId": session,
                            "clientId": client,
                            "epoch": epoch,
                            "revision": get()["revision"],
                            "machine": machine,
                            "workspace": str(workspace),
                        },
                    )

                first = prompt()
                assert "Machine: cloud" in first and f"Workspace: {cloud}" in first
                assert cloud_marker in first and "{{cloud-template}}" in first
                assert "Binding revision: 0." in first
                passed(
                    "authoritative workspace reaches the actual model HTTP system prompt"
                )

                original_client, original_epoch = client, epoch
                viewer = str(uuid.uuid4())
                readonly = api.remote(
                    "control", {"sessionId": session, "clientId": viewer}
                )
                assert not readonly["control"]["mine"]
                before_handoff = get()

                def handoff(to_client, machine, workspace, revision=None, **options):
                    return api.remote(
                        "switch",
                        {
                            "sessionId": session,
                            "clientId": to_client,
                            "label": "Handoff window",
                            "takeover": True,
                            "revision": get()["revision"]
                            if revision is None
                            else revision,
                            "machine": machine,
                            "workspace": str(workspace),
                        },
                        **options,
                    )

                api.remote(
                    "switch",
                    {
                        "sessionId": session,
                        "clientId": viewer,
                        "revision": before_handoff["revision"],
                        "machine": "laptop",
                        "workspace": str(remote),
                    },
                    rejected=True,
                )
                assert get()["current"] == before_handoff["current"]
                assert get()["control"] == before_handoff["control"]
                passed(
                    "a viewer cannot switch a shared session without explicitly taking over"
                )

                for who, machine, workspace, revision in [
                    ("invalid", "laptop", remote, before_handoff["revision"]),
                    (viewer, "unknown", remote, before_handoff["revision"]),
                    (
                        viewer,
                        "laptop",
                        remote / "does-not-exist",
                        before_handoff["revision"],
                    ),
                    (viewer, "laptop", remote, before_handoff["revision"] - 1),
                ]:
                    handoff(who, machine, workspace, revision, rejected=True)
                    assert get()["current"] == before_handoff["current"]
                    assert get()["control"] == before_handoff["control"]
                passed(
                    "invalid identities, targets, directories and stale selections cannot take over input or change the binding"
                )

                accepted_handoff = handoff(viewer, "laptop", remote)
                assert accepted_handoff["control"]["mine"]
                assert accepted_handoff["current"]["machine"] == "laptop"
                assert accepted_handoff["pending"] is None
                assert not get()["control"]["mine"]
                api.remote(
                    "input",
                    {
                        "clientId": original_client,
                        "epoch": original_epoch,
                        "method": "rename",
                        "payload": {"sessionId": session, "title": "STALE OWNER"},
                    },
                    rejected=True,
                )
                client, epoch = viewer, accepted_handoff["control"]["epoch"]
                handoff(
                    viewer,
                    "laptop",
                    remote,
                    before_handoff["revision"],
                    rejected=True,
                )
                assert get()["control"] == accepted_handoff["control"]
                assert get()["revision"] == accepted_handoff["revision"]
                passed(
                    "one explicit handoff selects the real SSH workspace, fences the old window and rejects repeated stale confirmation"
                )
                second = prompt()
                assert "Machine: laptop" in second and f"Workspace: {remote}" in second
                assert remote_marker in second and cloud_marker not in second
                assert (
                    "Current Git state:" in second and "Binding revision: 1." in second
                )
                passed(
                    "same conversation switch replaces machine, workspace and project instructions"
                )
                assert "Current Git state: context-fixture; clean." in second
                assert f'"root":"{remote}"' not in second
                for index in range(80):
                    (
                        remote / f"status-proof-{index:03}-{'long-name-' * 10}.txt"
                    ).write_text("new\n")
                dirty_prompt = prompt()
                git_section = dirty_prompt.split("Current Git state:", 1)[1].split(
                    "\n\n", 1
                )[0]
                assert "context-fixture; untracked 80." in git_section
                shown_entries = int(
                    git_section.split("Showing ", 1)[1].split("/", 1)[0]
                )
                assert 0 < shown_entries <= 8
                assert f"Showing {shown_entries}/80 entries" in git_section
                assert len(git_section) < 1100
                raw_git = json.loads((base / "state/environment.json").read_text())[
                    accepted_handoff["current"]["id"]
                ]["context"]["git"]
                assert (
                    raw_git["status"]
                    == subprocess.check_output(
                        ["git", "-C", str(remote), "status", "--short"], text=True
                    ).rstrip()
                )
                assert len(raw_git["status"].splitlines()) == 80
                assert (
                    remote_marker in dirty_prompt and cloud_marker not in dirty_prompt
                )
                passed(
                    "actual model requests receive a one-line clean Git state and a bounded fresh summary of a large dirty checkout"
                )

                remote_pick = api.remote(
                    "pick", {"machine": "laptop", "workspace": str(remote)}
                )
                catalog = api.remote("catalog", {})
                saved = {item["id"]: item for item in catalog["savedWorkspaces"]}
                assert picked["binding"]["id"] in saved
                target_id = remote_pick["binding"]["id"]
                assert saved[target_id]["workspace"] == str(remote)
                assert saved[target_id]["hostname"] == socket.gethostname()
                assert saved[target_id]["workspaceId"] == remote_pick["workspaceId"]
                assert {"read", "write", "edit", "bash", "grep", "find", "ls"} == set(
                    catalog["tools"]
                )
                passed(
                    "environment picker returns named native workspaces and actual tool capabilities"
                )

                before_probe = get()
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    probes = list(
                        pool.map(
                            lambda _: api.remote("probe", {"target": target_id}),
                            range(3),
                        )
                    )
                assert all(
                    result["status"] == "online" and result["checkedAt"] > 0
                    for result in probes
                )
                assert get()["connection"]["status"] == "online"
                assert get()["revision"] == before_probe["revision"]
                assert get()["control"] == before_probe["control"]
                passed(
                    "parallel live connection checks preserve the workspace and input controller"
                )

                displaced = remote.with_name("workspace-unavailable")
                remote.rename(displaced)
                try:
                    assert (
                        api.remote("probe", {"target": target_id})["status"]
                        == "unavailable"
                    )
                    unavailable = get()
                    assert unavailable["connection"]["status"] == "unavailable"
                    assert unavailable["current"] == before_probe["current"]
                    assert unavailable["revision"] == before_probe["revision"]
                    assert (
                        api.remote("probe", {"target": "cloud"})["status"] == "online"
                    )
                    api.remote("probe", {"target": "not-registered"}, rejected=True)
                    passed(
                        "unavailable workspaces report failure while the cloud stays usable and binding stays fixed"
                    )
                finally:
                    displaced.rename(remote)
                assert api.remote("probe", {"target": target_id})["status"] == "online"
                assert get()["connection"]["status"] == "online"
                assert remote_marker in api.read(session, "AGENTS.md")["text"]
                assert get()["revision"] == before_probe["revision"]
                passed(
                    "connection recovery uses the same target without a model turn or history change"
                )

                refreshed_marker = "REFRESHED-" + run_id
                instructions.write_text(
                    refreshed_marker + "\nKeep {{refreshed-template}} literal.\n"
                )
                third = prompt()
                assert refreshed_marker in third and remote_marker not in third
                assert "{{refreshed-template}}" in third
                passed(
                    "each turn refreshes project instructions and preserves literal template braces"
                )

                switch("cloud", cloud)
                fourth = prompt()
                assert cloud_marker in fourth and refreshed_marker not in fourth
                assert "Machine: cloud" in fourth and "Binding revision: 2." in fourth
                assert (
                    len(
                        [
                            m
                            for m in requests[-1]["messages"]
                            if m["role"] == "assistant"
                        ]
                    )
                    == 4
                )
                passed(
                    "switching back preserves conversation history and uses the latest binding"
                )
                other = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": picked["workspaceId"]}},
                )["sessionId"]
                assert other != session and api.remote("get", {"sessionId": other})[
                    "current"
                ]["workspace"] == str(cloud)
                api.rpc(
                    "workspace/rename",
                    {
                        "request": {
                            "workspaceId": picked["workspaceId"],
                            "title": "My cloud project",
                        }
                    },
                )
                assert (
                    api.remote("pick", {"machine": "cloud", "workspace": str(cloud)})[
                        "title"
                    ]
                    == "My cloud project"
                )
                passed(
                    "new sessions use the chosen workspace and explicit custom names are preserved"
                )

                before_running = len(requests)
                api.remote(
                    "input",
                    {
                        "clientId": client,
                        "epoch": epoch,
                        "method": "prompt",
                        "payload": {
                            "sessionId": session,
                            "requestId": str(uuid.uuid4()),
                            "mode": "queue",
                            "content": [{"type": "text", "text": running_marker}],
                        },
                    },
                )
                assert held_turn_started.wait(timeout=10)
                assert get()["running"]
                held_system = next(
                    message["content"]
                    for message in requests[-1]["messages"]
                    if message["role"] in {"system", "developer"}
                )
                assert "Machine: cloud" in held_system
                queued_handoff = handoff(original_client, "laptop", remote)
                assert queued_handoff["control"]["mine"]
                assert queued_handoff["current"]["machine"] == "cloud"
                assert queued_handoff["pending"]["machine"] == "laptop"
                assert queued_handoff["running"]
                client, epoch = original_client, queued_handoff["control"]["epoch"]
                queued_prompt = {
                    "sessionId": session,
                    "requestId": str(uuid.uuid4()),
                    "mode": "queue",
                    "content": [{"type": "text", "text": "CONTINUE-AFTER-HANDOFF"}],
                }
                for _ in range(2):
                    api.remote(
                        "input",
                        {
                            "clientId": client,
                            "epoch": epoch,
                            "method": "prompt",
                            "payload": queued_prompt,
                        },
                    )
                assert len(requests) == before_running + 1
                passed(
                    "handoff during a real active turn keeps its original machine while the new controller can queue the next prompt"
                )
                release_turn.set()
                wait_for(lambda: len(requests) > before_running + 1, timeout=30)
                wait_for(get, lambda value: not value["running"], timeout=30)
                assert len(requests) == before_running + 2
                assert get()["current"]["machine"] == "laptop"
                assert get()["pending"] is None
                final_system = next(
                    message["content"]
                    for message in requests[-1]["messages"]
                    if message["role"] in {"system", "developer"}
                )
                assert "Machine: laptop" in final_system
                assert (
                    refreshed_marker in final_system
                    and cloud_marker not in final_system
                )
                assert api.read(session, "AGENTS.md")["text"].startswith(
                    refreshed_marker
                )
                passed(
                    "the queued prompt runs once after handoff with the new machine, current project instructions and matching file browser"
                )

                def workers():
                    found = set()
                    for proc in Path("/proc").iterdir():
                        if not proc.name.isdecimal():
                            continue
                        try:
                            command = (proc / "cmdline").read_bytes().split(b"\0")
                        except OSError:
                            continue
                        if str(remote).encode() in command and any(
                            argument.endswith(b"/worker.mjs") for argument in command
                        ):
                            found.add(int(proc.name))
                    return found

                original_workers = workers()
                slow_pick = api.remote(
                    "pick", {"machine": "slow", "workspace": str(remote)}
                )
                extra_workers = workers() - original_workers
                assert len(extra_workers) == 1
                paused_worker = extra_workers.pop()

                def queued_worker_input():
                    # Observe the actual paused worker's pipe without consuming
                    # it, proving a context read or preflight already started.
                    descriptor = os.open(
                        f"/proc/{paused_worker}/fd/0", os.O_RDONLY | os.O_NONBLOCK
                    )
                    try:
                        count = array.array("i", [0])
                        fcntl.ioctl(descriptor, termios.FIONREAD, count, True)
                        return count[0]
                    finally:
                        os.close(descriptor)

                detached = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": slow_pick["workspaceId"]}},
                )["sessionId"]
                detached_client = str(uuid.uuid4())
                detached_control = api.remote(
                    "control", {"sessionId": detached, "clientId": detached_client}
                )
                detached_epoch = detached_control["control"]["epoch"]

                def detached_get(sid=detached, owner=detached_client):
                    return api.remote("get", {"sessionId": sid, "clientId": owner})

                def detached_prompt(
                    label,
                    sid=detached,
                    owner=detached_client,
                    credential=detached_epoch,
                ):
                    count = len(requests)
                    api.remote(
                        "input",
                        {
                            "clientId": owner,
                            "epoch": credential,
                            "method": "prompt",
                            "payload": {
                                "sessionId": sid,
                                "requestId": str(uuid.uuid4()),
                                "mode": "queue",
                                "content": [
                                    {"type": "text", "text": "DETACHED-CLOUD-" + label}
                                ],
                            },
                        },
                    )
                    return count

                def detached_completed(sid=detached, owner=detached_client):
                    return wait_for(
                        lambda: detached_get(sid, owner),
                        lambda value: not value["running"],
                        timeout=24,
                    )

                def detached_proof(count, unavailable):
                    assert len(requests) == count + 2
                    for payload in requests[count:]:
                        current_system = "\n".join(
                            str(message["content"])
                            for message in payload["messages"]
                            if message["role"] in {"system", "developer"}
                        )
                        assert "Machine: slow" in current_system
                        assert refreshed_marker in current_system
                        assert (
                            "Target connection error:" in current_system
                        ) == unavailable
                        assert (
                            "Last known project instructions" in current_system
                        ) == unavailable
                        assert ("Last known Git state" in current_system) == unavailable
                    assert any(
                        cloud_marker in str(message["content"])
                        for message in requests[-1]["messages"]
                        if message["role"] == "tool"
                    )

                original_detached = detached_get()
                try:
                    os.kill(paused_worker, signal.SIGSTOP)
                    started = time.monotonic()
                    count = detached_prompt("BOUNDED")
                    unavailable = detached_completed()
                    detached_timings["firstUnavailableTurnSeconds"] = (
                        time.monotonic() - started
                    )
                    assert 10 <= detached_timings["firstUnavailableTurnSeconds"] < 24
                    detached_proof(count, True)
                    assert unavailable["current"] == original_detached["current"]
                    assert unavailable["control"] == original_detached["control"]
                    assert unavailable["revision"] == original_detached["revision"]
                    assert unavailable["pending"] is None
                    assert unavailable["connection"]["status"] == "unavailable"
                    assert workers() == original_workers | {paused_worker}
                    passed(
                        "a paused default device cannot delay explicit cloud work beyond the bounded context check; every model step sees the original target and stale facts"
                    )

                    started = time.monotonic()
                    count = detached_prompt("KNOWN-UNAVAILABLE")
                    detached_completed()
                    detached_timings["knownUnavailableTurnSeconds"] = (
                        time.monotonic() - started
                    )
                    assert detached_timings["knownUnavailableTurnSeconds"] < 8
                    detached_proof(count, True)
                    assert api.read(session, "AGENTS.md")["text"].startswith(
                        refreshed_marker
                    )
                    passed(
                        "known unavailability skips repeated waits while actual cloud tool results and other SSH workspace reads remain available"
                    )
                finally:
                    if paused_worker in workers():
                        os.kill(paused_worker, signal.SIGCONT)
                assert (
                    api.remote("probe", {"target": slow_pick["binding"]["id"]})[
                        "status"
                    ]
                    == "online"
                )

                peer = api.rpc(
                    "session/create",
                    {"request": {"workspaceId": slow_pick["workspaceId"]}},
                )["sessionId"]
                peer_client = str(uuid.uuid4())
                peer_control = api.remote(
                    "control", {"sessionId": peer, "clientId": peer_client}
                )
                peer_epoch = peer_control["control"]["epoch"]
                wait_for(queued_worker_input, lambda value: value == 0, timeout=10)
                try:
                    os.kill(paused_worker, signal.SIGSTOP)
                    count = detached_prompt("CANCEL")
                    pending_bytes = wait_for(queued_worker_input, timeout=10)
                    detached_prompt("PEER", peer, peer_client, peer_epoch)
                    wait_for(
                        queued_worker_input,
                        lambda value: value > pending_bytes,
                        timeout=10,
                    )
                    api.remote(
                        "input",
                        {
                            "clientId": detached_client,
                            "epoch": detached_epoch,
                            "method": "cancel",
                            "payload": {"sessionId": detached},
                        },
                    )
                    canceled = detached_completed()
                    assert canceled["current"] == original_detached["current"]
                    assert canceled["control"] == original_detached["control"]
                    completed_peer = detached_completed(peer, peer_client)
                    assert completed_peer["control"] == peer_control["control"]
                    detached_proof(count, True)
                    assert all(
                        "DETACHED-CLOUD-PEER" in str(payload["messages"])
                        for payload in requests[count:]
                    )
                    assert workers() == original_workers | {paused_worker}
                    passed(
                        "canceling one context wait sends no model request and preserves another session using the same paused transport"
                    )
                finally:
                    if paused_worker in workers():
                        os.kill(paused_worker, signal.SIGCONT)
                instructions.write_text(
                    instructions.read_text() + "RESTORED-CONTEXT-" + run_id + "\n"
                )
                assert (
                    api.remote("probe", {"target": slow_pick["binding"]["id"]})[
                        "status"
                    ]
                    == "online"
                )
                count = detached_prompt("RECOVERED")
                recovered = detached_completed()
                detached_proof(count, False)
                assert "RESTORED-CONTEXT-" + run_id in str(requests[-1]["messages"])
                assert recovered["current"] == original_detached["current"]
                assert recovered["control"] == original_detached["control"]
                assert recovered["revision"] == original_detached["revision"]
                assert workers() == original_workers | {paused_worker}
                passed(
                    "connection recovery refreshes the same device's latest project instructions and clears stale warnings without switching or replacing its worker"
                )

                before_timeout = get()
                try:
                    # Pause only this isolated SSH target's real MCP worker;
                    # its already established transport receives the probe.
                    os.kill(paused_worker, signal.SIGSTOP)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        start = time.monotonic()
                        delayed = pool.submit(
                            api.remote,
                            "probe",
                            {"target": slow_pick["binding"]["id"]},
                        )
                        assert (
                            api.remote("probe", {"target": "cloud"})["status"]
                            == "online"
                        )
                        result = delayed.result(timeout=18)
                        assert result["status"] == "unavailable"
                        assert "超时" in result["error"]
                        assert 10 <= time.monotonic() - start < 18
                        assert get()["revision"] == before_timeout["revision"]
                        assert get()["current"] == before_timeout["current"]
                finally:
                    if paused_worker in workers():
                        os.kill(paused_worker, signal.SIGCONT)
                assert (
                    api.remote("probe", {"target": slow_pick["binding"]["id"]})[
                        "status"
                    ]
                    == "online"
                )
                passed(
                    "a delayed real SSH probe times out within its bound, preserves other targets and recovers"
                )

                cookies = next(
                    handler.cookiejar
                    for handler in api.browser.handlers
                    if hasattr(handler, "cookiejar")
                )
                cookie = "; ".join(f"{entry.name}={entry.value}" for entry in cookies)
                for takeover in (True, False):
                    before_cancel = get()
                    model_count = len(requests)
                    request = {
                        "sessionId": session,
                        "revision": before_cancel["revision"],
                        "machine": "slow",
                        "workspace": str(remote),
                        "clientId": str(uuid.uuid4()) if takeover else client,
                        "takeover": takeover,
                        "epoch": before_cancel["control"]["epoch"],
                    }
                    assert queued_worker_input() == 0
                    caller = None
                    try:
                        os.kill(paused_worker, signal.SIGSTOP)
                        caller = subprocess.Popen(
                            [args.node, str(ROOT / "verify_dsh_handoff_rpc.mjs")],
                            stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            text=True,
                        )
                        caller.stdin.write(
                            json.dumps(
                                {
                                    "origin": api.origin,
                                    "cookie": cookie,
                                    "request": request,
                                }
                            )
                            + "\n"
                        )
                        caller.stdin.flush()
                        wait_for(queued_worker_input, timeout=10)
                        caller.stdin.write("cancel\n")
                        caller.stdin.flush()
                        caller.wait(timeout=5)
                        assert caller.returncode == 0, caller.stderr.read()
                        assert "PASS native fetch cancellation" in caller.stdout.read()
                        during_cancel = get()
                        assert during_cancel["current"] == before_cancel["current"]
                        assert during_cancel["revision"] == before_cancel["revision"]
                        assert during_cancel["control"] == before_cancel["control"]
                    finally:
                        if paused_worker in workers():
                            os.kill(paused_worker, signal.SIGCONT)
                        if caller:
                            if caller.poll() is None:
                                caller.kill()
                                caller.wait()
                            for stream in (caller.stdin, caller.stdout, caller.stderr):
                                try:
                                    stream.close()
                                except BrokenPipeError:
                                    pass
                    # A real round trip drains the resumed worker after its
                    # cancelled preflight, proving no delayed handoff commits.
                    api.remote("pick", {"machine": "slow", "workspace": str(remote)})
                    after_cancel = get()
                    assert after_cancel["current"] == before_cancel["current"]
                    assert after_cancel["revision"] == before_cancel["revision"]
                    assert after_cancel["control"] == before_cancel["control"]
                    assert after_cancel["pending"] is None
                    assert len(requests) == model_count
                    assert api.read(session, "AGENTS.md")["text"].startswith(
                        refreshed_marker
                    )
                    passed(
                        "cancelling a real native HTTP "
                        + ("handoff" if takeover else "workspace switch")
                        + " preserves input ownership and the binding after the paused SSH worker resumes, without breaking shared tools"
                    )

                before_race = get()
                contender, newer_window = str(uuid.uuid4()), str(uuid.uuid4())
                assert queued_worker_input() == 0
                try:
                    os.kill(paused_worker, signal.SIGSTOP)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        delayed_handoff = pool.submit(
                            handoff,
                            contender,
                            "slow",
                            remote,
                            before_race["revision"],
                            rejected=True,
                        )
                        wait_for(queued_worker_input, timeout=10)
                        newer_control = api.remote(
                            "control",
                            {
                                "sessionId": session,
                                "clientId": newer_window,
                                "takeover": True,
                                "label": "Newer explicit takeover",
                            },
                        )
                        assert newer_control["control"]["mine"]
                        os.kill(paused_worker, signal.SIGCONT)
                        failure = delayed_handoff.result(timeout=15)
                        assert "输入权" in failure["message"]
                finally:
                    if paused_worker in workers():
                        os.kill(paused_worker, signal.SIGCONT)
                latest = api.remote(
                    "get", {"sessionId": session, "clientId": newer_window}
                )
                assert latest["control"] == newer_control["control"]
                assert latest["current"] == before_race["current"]
                assert latest["revision"] == before_race["revision"]
                assert latest["pending"] is None
                passed(
                    "a slow real SSH handoff cannot overwrite a newer explicit controller and leaves the execution target unchanged"
                )
                (ROOT / ".local/verification-dsh-context.json").write_text(
                    json.dumps(
                        {
                            "checks": checks,
                            "modelRequests": len(requests),
                            "detachedTimings": detached_timings,
                            "gitPrompt": {
                                "dirtyEntries": 80,
                                "shownEntries": shown_entries,
                                "dirtyChars": len(git_section),
                                "rawContextPreserved": True,
                            },
                            "sessionId": session,
                        },
                        indent=2,
                    )
                    + "\n"
                )
    finally:
        release_turn.set()
        if host:
            host.terminate()
            try:
                host.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(host.pid, signal.SIGKILL)
                host.wait()
        recorder.shutdown()
        recorder.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    run(parser.parse_args())
