"""Exercise launcher waits and cancellation with real user jobs, SSH and DSH."""

import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

from device_onboarding import save
from ssh_fixture import ROOT, SSHFixture, free_port
from verify_dsh import DshApi, wait_for


def verify(args, base):
    cloud, other, home, state = (
        base / "cloud project",
        base / "other project",
        base / "home",
        base / "state",
    )
    cloud.mkdir()
    other.mkdir()
    save(base / "targets.json", {"targets": {}})
    save(
        base / "models.json",
        {
            "providers": {
                "fixture": {
                    "baseUrl": "http://127.0.0.1:1/v1",
                    "api": "openai-completions",
                    "models": [
                        {
                            "id": "unused-fixture",
                            "contextWindow": 128000,
                            "maxTokens": 1024,
                        }
                    ],
                }
            }
        },
    )
    subprocess.run(
        [
            args.node,
            str(ROOT / "configure-dsh.mjs"),
            "--home",
            str(home),
            "--state",
            str(state),
            "--workspace",
            str(cloud),
            "--targets",
            str(base / "targets.json"),
            "--python",
            sys.executable,
            "--model",
            str(base / "models.json"),
        ],
        check=True,
        capture_output=True,
    )
    host, paused = None, False
    port, jobs, children, checks = free_port(), [], [], []

    def passed(name):
        checks.append(name)
        print("PASS " + name, flush=True)

    def stop_host():
        nonlocal host, paused
        if host and host.poll() is None:
            if paused:
                os.killpg(host.pid, signal.SIGCONT)
                paused = False
            os.killpg(host.pid, signal.SIGTERM)
            host.wait(timeout=15)
        host = None

    def start_host():
        nonlocal host
        with (base / "host.log").open("a") as log:
            os.chmod(log.name, 0o600)
            host = subprocess.Popen(
                [
                    args.node,
                    str(ROOT / "dsh-host.mjs"),
                    "--home",
                    str(home),
                    "--state",
                    str(state),
                    "--workspace",
                    str(cloud),
                    "--port",
                    str(port),
                ],
                stdout=log,
                stderr=log,
                start_new_session=True,
                env={
                    **os.environ,
                    "REMOTE_MCP_CHECK_API_KEY": "unused-fixture-key",
                },
            )
        return wait_for(
            lambda: (
                DshApi(json.loads((state / "web-url.json").read_text())["url"])
                if (state / "web-url.json").exists()
                else None
            ),
            timeout=30,
        )

    def pause_host():
        nonlocal paused
        os.killpg(host.pid, signal.SIGSTOP)
        paused = True

    def resume_host():
        nonlocal paused
        os.killpg(host.pid, signal.SIGCONT)
        paused = False

    def launch(profile, workspace=cloud, *extra):
        index = len(children)
        out, err = base / f"launch-{index}.out", base / f"launch-{index}.err"
        with out.open("w") as output, err.open("w") as errors:
            out.chmod(0o600)
            err.chmod(0o600)
            child = subprocess.Popen(
                [
                    args.node,
                    str(ROOT / "dsh-remote.mjs"),
                    "--profile",
                    str(profile),
                    "--workspace",
                    str(workspace),
                    "--no-open",
                    *extra,
                ],
                stdout=output,
                stderr=errors,
            )
        children.append(child)
        return child, out, err

    def url_in(output):
        line = output.read_text().splitlines()[0]
        assert line.startswith("云端 DSH 已连接：")
        return line.split("：", 1)[1]

    def check_launch(profile, workspace=cloud, *extra):
        child, out, err = launch(profile, workspace, *extra)
        assert child.wait(timeout=25) == 0, err.read_text()
        url = url_in(out)
        hint = urllib.parse.parse_qs(urllib.parse.urlsplit(url).fragment)
        assert hint["machine"] == ["cloud"]
        assert hint["workspace"] == [str(workspace)]
        api = DshApi(url)
        assert api.rpc("session/list", {"_request": {}})["items"] == []
        assert "正在连接云端 DSH" in err.read_text()
        return url

    def alive(pid):
        os.kill(pid, 0)
        return True

    try:
        api = start_host()
        with SSHFixture(node=args.node, npm=args.npm) as fixture:
            connection = json.loads(fixture.config.read_text())["targets"]["laptop"]
            ssh = {
                **connection,
                "base": str(ROOT),
                "state": str(state),
                "webPort": port,
            }
            for native in [False, True]:
                profile = {
                    "machine": "cloud",
                    "cloud": ssh,
                    "localPort": free_port(),
                    **(
                        {"nativeJobs": True, "python": sys.executable} if native else {}
                    ),
                }
                file = base / ("native.json" if native else "legacy.json")
                save(file, profile)
                tag = hashlib.sha256(
                    json.dumps(
                        profile, separators=(",", ":"), ensure_ascii=False
                    ).encode()
                ).hexdigest()[:16]
                unit = f"remote-dsh-web-{tag}.service"
                cache = Path.home() / ".cache/remote-dsh" / (tag + ".json")
                jobs.append((unit, tag, cache))
                mode = "native supervisor" if native else "direct user service"
                check_launch(file)
                pid = json.loads(cache.read_text())["pid"]
                check_launch(file, other)
                assert json.loads(cache.read_text())["pid"] == pid and alive(pid)
                passed(
                    mode + " cold start and warm reuse preserve each invoking directory"
                )

                saved_entry = cache.read_bytes()
                child, out, err = launch(file, cloud, "--foreground")
                wait_for(lambda: out.read_text(), timeout=30)
                assert cache.read_bytes() == saved_entry
                assert (
                    DshApi(url_in(out)).rpc("session/list", {"_request": {}})["items"]
                    == []
                )
                child.send_signal(signal.SIGINT)
                assert child.wait(timeout=5) == 130
                assert cache.read_bytes() == saved_entry and alive(pid)
                check_launch(file)
                assert json.loads(cache.read_text())["pid"] == pid
                passed(
                    mode
                    + " foreground connection preserves the background entry during and after use"
                )

                cache.unlink()
                check_launch(file)
                healed_pid = json.loads(cache.read_text())["pid"]
                assert healed_pid != pid and alive(healed_pid)
                pid = healed_pid
                stale = json.loads(cache.read_text())
                stale["pid"] = os.getpid()
                save(cache, stale)
                check_launch(file)
                healed_pid = json.loads(cache.read_text())["pid"]
                assert healed_pid != pid and alive(healed_pid)
                pid = healed_pid
                passed(
                    mode
                    + " repairs missing or stale entry cache without creating sessions"
                )

                pause_host()
                child, out, err = launch(file)
                wait_for(lambda: "已等待 10 秒" in err.read_text(), timeout=15)
                child.send_signal(signal.SIGINT)
                assert child.wait(timeout=5) == 130
                assert not out.read_text() and "已停止等待" in err.read_text()
                assert json.loads(cache.read_text())["pid"] == pid and alive(pid)
                resume_host()
                check_launch(file)
                assert json.loads(cache.read_text())["pid"] == pid
                passed(
                    mode
                    + " reports progress; cancelling wait leaves the connection usable"
                )

                if native:
                    pause_host()
                    started = time.monotonic()
                    child, out, err = launch(file)
                    assert child.wait(timeout=52) == 1
                    elapsed = time.monotonic() - started
                    assert 44 <= elapsed < 52
                    assert not out.read_text()
                    assert "超过 45 秒" in err.read_text()
                    assert ".local/share/remote-dsh-device/jobs/web-" in err.read_text()
                    assert alive(pid)
                    resume_host()
                    check_launch(file)
                    assert json.loads(cache.read_text())["pid"] == pid
                    passed(
                        "bounded background wait explains recovery and keeps the original job"
                    )

                old_url = json.loads(cache.read_text())["url"]
                stop_host()
                start_host()
                check_launch(file, other)
                refreshed = json.loads(cache.read_text())
                assert refreshed["url"] != old_url and refreshed["pid"] != pid
                passed(mode + " refreshes expired login after a real Host restart")

            direct = base / "direct.json"
            save(direct, {"machine": "cloud", "localState": str(state)})
            check_launch(direct)
            passed("direct cloud launcher exits cleanly and retains the directory hint")

            foreground = base / "foreground.json"
            save(foreground, {"machine": "cloud", "cloud": ssh})
            child, out, err = launch(foreground, cloud, "--foreground")
            wait_for(lambda: out.read_text(), timeout=30)
            launch_url = url_in(out)
            assert (
                DshApi(launch_url).rpc("session/list", {"_request": {}})["items"] == []
            )
            local_port = urllib.parse.urlsplit(launch_url).port
            child.send_signal(signal.SIGINT)
            assert child.wait(timeout=5) == 130
            assert "云端 Agent 与会话继续保留" in err.read_text()
            assert alive(host.pid)
            with socket.socket() as probe:
                assert probe.connect_ex(("127.0.0.1", local_port)) != 0
            passed(
                "foreground cancellation closes only its SSH forwarding and preserves Host"
            )

            denied = base / "denied.json"
            save(
                denied,
                {
                    "machine": "cloud",
                    "cloud": {
                        **ssh,
                        "identity_file": str(fixture.directory / "denied_key"),
                    },
                },
            )
            child, out, err = launch(denied, cloud, "--foreground")
            assert child.wait(timeout=15) == 1
            assert not out.read_text()
            assert "Permission denied" in err.read_text()
            assert "云端连接未建立" in err.read_text()
            passed("real SSH authentication rejection produces no usable launch URL")

            invalid = base / "invalid.json"
            save(invalid, {"machine": "unknown", "localState": str(state)})
            child, out, err = launch(invalid)
            assert child.wait(timeout=15) == 1
            assert (
                not out.read_text()
                and "Unknown SSH machine: unknown" in err.read_text()
            )
            assert "at Interface" not in err.read_text()
            passed(
                "remote entry rejection is reported without an uncaught callback error"
            )

            api = DshApi(json.loads((state / "web-url.json").read_text())["url"])
            assert api.rpc("session/list", {"_request": {}})["items"] == []
            passed(
                "all startup, cancellation and recovery checks leave session history untouched"
            )
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
        for unit, tag, cache in jobs:
            subprocess.run(
                ["systemctl", "--user", "disable", "--now", unit],
                capture_output=True,
            )
            (Path.home() / ".config/systemd/user" / unit).unlink(missing_ok=True)
            cache.unlink(missing_ok=True)
            for suffix in [".json", ".status.json", ".lock", ".log"]:
                (
                    Path.home()
                    / ".local/share/remote-dsh-device/jobs"
                    / ("web-" + tag + suffix)
                ).unlink(missing_ok=True)
            subprocess.run(
                ["systemctl", "--user", "reset-failed", unit], capture_output=True
            )
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"], check=True, capture_output=True
        )
        stop_host()
    return {"checks": checks, "passed": len(checks), "modelCalls": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".local/verification-dsh-launcher.json"
    )
    args = parser.parse_args()
    if sys.platform != "linux" or not shutil.which("systemctl"):
        parser.error("This integration check requires Linux and a user service manager")
    subprocess.run(
        ["systemctl", "--user", "show-environment"], check=True, capture_output=True
    )
    with tempfile.TemporaryDirectory(
        prefix="dsh-launcher-", dir=ROOT / ".local"
    ) as temp:
        result = verify(args, Path(temp))
    save(args.output, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
