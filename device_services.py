"""Native per-user background jobs for Linux, macOS and Windows."""

import argparse
import ctypes
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path


def run(args, check=True):
    result = subprocess.run(
        args,
        text=True,
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result


def live(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
        kernel.CloseHandle(ctypes.c_void_p(handle))
        return code.value == 259
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def powershell(script):
    import base64

    return [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        base64.b64encode(script.encode("utf-16le")).decode(),
    ]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def start(name, args, force=False, *, supervisor=None):
    if not all(char.isalnum() or char == "-" for char in name):
        raise ValueError("Invalid background job name")
    base = Path.home() / ".local/share/remote-dsh-device/jobs"
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    job = base / (name + ".json")
    python = Path(sys.executable)
    if os.name == "nt" and python.with_name("pythonw.exe").exists():
        python = python.with_name("pythonw.exe")
    supervisor = str(supervisor or Path(__file__).with_name("device_supervisor.py"))
    digest = hashlib.sha256(
        json.dumps([str(python), supervisor, *args]).encode()
    ).hexdigest()
    status = base / (name + ".status.json")
    snapshot = json.loads(status.read_text()) if status.exists() else {}
    if not force and snapshot.get("digest") == digest and live(snapshot.get("pid")):
        return snapshot.get("childPid", 0)
    payload = {"args": args, "digest": digest, "name": name}
    job.write_text(json.dumps(payload))
    job.chmod(0o600)
    invocation = [str(python), supervisor, "--job", str(job)]
    if sys.platform == "linux":
        unit = (
            Path.home() / ".config/systemd/user" / ("remote-dsh-" + name + ".service")
        )
        unit.parent.mkdir(parents=True, exist_ok=True)
        unit.write_text(
            "\n".join(
                [
                    "[Unit]",
                    "Description=Remote DSH " + name,
                    "After=network-online.target",
                    "",
                    "[Service]",
                    "ExecStart="
                    + " ".join(
                        json.dumps(value.replace("%", "%%")) for value in invocation
                    ),
                    "Environment=PYTHONUTF8=1",
                    "Restart=always",
                    "RestartSec=5",
                    "",
                    "[Install]",
                    "WantedBy=default.target",
                    "",
                ]
            )
        )
        unit.chmod(0o600)
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "enable", unit.name])
        run(["systemctl", "--user", "restart", unit.name])
    elif sys.platform == "darwin":
        label = "dev.remote-dsh." + name
        path = Path.home() / "Library/LaunchAgents" / (label + ".plist")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            plistlib.dumps(
                {
                    "Label": label,
                    "ProgramArguments": invocation,
                    "RunAtLoad": True,
                    "KeepAlive": True,
                    "ThrottleInterval": 5,
                    "EnvironmentVariables": {"PYTHONUTF8": "1"},
                }
            )
        )
        path.chmod(0o600)
        domain = f"gui/{os.getuid()}"
        run(["launchctl", "bootout", domain + "/" + label], check=False)
        run(["launchctl", "bootstrap", domain, str(path)])
    elif os.name == "nt":
        shortcut = (
            Path(os.environ["APPDATA"])
            / "Microsoft/Windows/Start Menu/Programs/Startup"
            / ("RemoteDSH-" + name + ".lnk")
        )
        shortcut.parent.mkdir(parents=True, exist_ok=True)
        arguments = subprocess.list2cmdline(invocation[1:])
        script = f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut({literal(shortcut)});$s.TargetPath={literal(python)};$s.Arguments={literal(arguments)};$s.WindowStyle=7;$s.Save()"
        run(powershell(script))
        # These PIDs came from the private job status, with a recent heartbeat.
        if time.time() - snapshot.get("updatedAt", 0) < 10:
            for pid in [snapshot.get("childPid"), snapshot.get("pid")]:
                if live(pid):
                    run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False)
        subprocess.Popen(
            invocation,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
    else:
        raise RuntimeError("Unsupported operating system")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        snapshot = json.loads(status.read_text()) if status.exists() else {}
        if snapshot.get("digest") == digest and live(snapshot.get("childPid")):
            return snapshot["childPid"]
        time.sleep(0.2)
    raise RuntimeError(
        "后台连接未启动，请查看用户目录 remote-dsh-device/jobs 中的日志。"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["web-start", "web-restart", "web-status"])
    parser.add_argument("--name", required=True)
    parser.add_argument("--node")
    parser.add_argument("--entry")
    parser.add_argument("--profile")
    parser.add_argument("--port")
    args = parser.parse_args()
    try:
        if args.action in {"web-start", "web-restart"}:
            pid = start(
                args.name,
                [
                    args.node,
                    args.entry,
                    "--foreground",
                    "--no-open",
                    "--connection-only",
                    "--profile",
                    args.profile,
                    "--port",
                    args.port,
                ],
                force=args.action == "web-restart",
            )
        else:
            path = (
                Path.home()
                / ".local/share/remote-dsh-device/jobs"
                / (args.name + ".status.json")
            )
            snapshot = json.loads(path.read_text()) if path.exists() else {}
            pid = (
                snapshot.get("childPid", 0)
                if live(snapshot.get("pid")) and live(snapshot.get("childPid"))
                else 0
            )
        print(json.dumps({"pid": pid}))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
