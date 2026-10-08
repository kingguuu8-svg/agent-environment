# Agent Environment

A shared working environment for agents across your devices. Register machines, workspaces and MCP services on one persistent host. Existing agents keep their own models, conversations and local tools while calling native tools on explicit remote targets.

The optional DSH Web host runs the agent and stores conversations centrally. Open the same conversation from another device, change its execution machine and directory, and continue with refreshed workspace context. The file browser follows the execution binding.

[中文](README.md) · [Quickstart](docs/QUICKSTART.md) · [Deployment](docs/DEPLOYMENT.md) · [Architecture](docs/ARCHITECTURE.md)

## Start an Environment

On a Linux host, install Node.js 22.19.0+, Python 3.11+, [uv](https://docs.astral.sh/uv/getting-started/installation/) and the OpenSSH client. Clone the repository and start the environment:

```bash
git clone https://github.com/kingguuu8-svg/agent-environment.git
cd agent-environment
sh scripts/setup.sh environment
mkdir -p "$HOME/agent-workspace"
python3 agent_environment.py init --workspace "$HOME/agent-workspace"
python3 agent_environment.py doctor
python3 agent_environment.py start
```

The private `.local/platform/connection.md` contains a URL, account and randomly generated key. Give it to an agent that can make HTTP requests or connect to MCP. The URL describes the protocol; authenticated discovery returns explicit target IDs and native tool schemas.

For a second device, copy `targets.example.json` to a private `targets.json`, configure an existing SSH connection, and pass `--targets targets.json` during initialization. Each call specifies a target and runs with that machine's OS user permissions.

## Optional Web host

Run `sh scripts/setup.sh dsh`, configure a provider in a private copy of `models.example.json`, then initialize with `--mode dsh --model <file>`. Credentials are referenced through environment variables or private `model.env`. The [quickstart](docs/QUICKSTART.md) covers Web access and generated device installers.

## Execution contract

Native `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` come from pinned Pi tool factories. Images, edit metadata, structured results and cancellation are preserved. Additional MCP services can join the same environment.

Workspaces define the working directory; OS permissions define file access. Calls are never automatically replayed after a lost response. Check target state before retrying a mutation. Existing agents share resources while retaining their own conversations; DSH clients share centrally stored conversations and explicitly hand over input ownership.

## Status

Early software for personal, trusted devices. Linux Host deployment, real SSH tools and cross-device conversations are tested. macOS and Windows device installers are previews. DSH is pinned to `0.2.0-rc.2` and uses version-checked integration patches. Model endpoints and individual model capabilities depend on your provider configuration.

[Verification](docs/VERIFICATION.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
