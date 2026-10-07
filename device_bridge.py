"""Private loopback endpoint carrying native Pi stdio tools through outbound SSH."""

import argparse
import asyncio
import hmac
import json
import os
import subprocess
import sys
from pathlib import Path


async def serve(config):
    active = set()

    async def connection(reader, writer):
        process = None
        pumps = []
        try:
            if len(active) >= 32:
                raise ValueError("Device connection limit reached")
            active.add(writer)
            request = json.loads(await asyncio.wait_for(reader.readline(), 10))
            if not hmac.compare_digest(str(request.pop("token", "")), config["token"]):
                raise ValueError("Device authentication failed")
            environment = {
                **os.environ,
                "PATH": config["path"] + os.pathsep + os.environ.get("PATH", ""),
            }
            native_options = (
                {"creationflags": subprocess.CREATE_NO_WINDOW}
                if os.name == "nt"
                else {}
            )
            if request.get("action") == "bootstrap":
                incoming_bundle = request.get("request") or json.loads(
                    await asyncio.wait_for(reader.readline(), 90)
                )
                payload = {
                    **incoming_bundle,
                    "node": config["node"],
                    "npm": config["npm"],
                    "remote_base": config["workerRoot"],
                    "require_existing_workspace": True,
                }
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    str(Path(__file__).with_name("bootstrap.py")),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=environment,
                    **native_options,
                )
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(json.dumps(payload).encode()), 240
                )
                if process.returncode:
                    raise ValueError(stderr.decode(errors="replace")[-1800:])
                writer.write(
                    json.dumps({"ok": True, "value": json.loads(stdout)}).encode()
                    + b"\n"
                )
                await writer.drain()
                return
            if request.get("action") != "worker":
                raise ValueError("Unknown device operation")
            workspace = Path(request["workspace"]).expanduser().resolve(strict=True)
            if not workspace.is_dir():
                raise ValueError("Workspace must be a directory")
            process = await asyncio.create_subprocess_exec(
                config["node"],
                str(Path(config["workerRoot"]) / "worker.mjs"),
                "--workspace",
                str(workspace),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=environment,
                **native_options,
            )
            writer.write(b'{"ok":true}\n')
            await writer.drain()

            async def incoming():
                while chunk := await reader.read(65536):
                    process.stdin.write(chunk)
                    await process.stdin.drain()
                process.stdin.close()

            async def outgoing():
                while chunk := await process.stdout.read(65536):
                    writer.write(chunk)
                    await writer.drain()

            pumps = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except Exception as error:
            writer.write(
                json.dumps(
                    {"ok": False, "error": str(error) or type(error).__name__}
                ).encode()
                + b"\n"
            )
            try:
                await writer.drain()
            except ConnectionError:
                pass
        finally:
            for task in pumps:
                task.cancel()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            active.discard(writer)
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(
        connection, "127.0.0.1", config["localPort"], limit=1024 * 1024
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(serve(json.loads(args.config.read_text())))
