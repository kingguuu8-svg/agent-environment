"""One-command verification with a fresh SSH target and no existing MCP bundle."""

import argparse
import asyncio
import json
from pathlib import Path

from ssh_fixture import ROOT, SSHFixture
from verify import verify

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".local/verification-local.json"
    )
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default="npm")
    args = parser.parse_args()
    with SSHFixture(node=args.node, npm=args.npm) as fixture:
        result = asyncio.run(
            verify(
                argparse.Namespace(
                    url=None,
                    config=fixture.config,
                    machine="laptop",
                    denied_machine="denied",
                )
            )
        )
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized)
    print(serialized)
