"""Keep one device background job alive and expose its current child PID."""

import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path


def supervise(job):
    lock = job.with_suffix(".lock").open("a+b")
    if os.name == "nt":
        import msvcrt

        lock.write(b"\0")
        lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stopped, child = False, None

    def stop(*_):
        nonlocal stopped
        stopped = True
        if child and child.poll() is None:
            child.terminate()

    for value in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(value, stop)
    status = job.with_suffix(".status.json")
    with lock, job.with_suffix(".log").open("ab") as log:
        os.chmod(job.with_suffix(".log"), 0o600)
        while not stopped:
            config = json.loads(job.read_text())
            child = subprocess.Popen(
                config["args"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                env={**os.environ, "PYTHONUTF8": "1"},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            while not stopped and child.poll() is None:
                temporary = status.with_suffix(".tmp")
                temporary.write_text(
                    json.dumps(
                        {
                            "pid": os.getpid(),
                            "childPid": child.pid,
                            "digest": config["digest"],
                            "updatedAt": time.time(),
                        }
                    )
                )
                temporary.chmod(0o600)
                temporary.replace(status)
                time.sleep(1)
            if stopped:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            else:
                time.sleep(5)
        status.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    supervise(args.job)
