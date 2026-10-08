# Contributing

Start with a cross-device workflow that fails or is difficult to use. Describe the devices, workspace, expected effect and observed result. A useful change makes execution location clearer, connection recovery more reliable, or setup easier to repeat.

## Development

Use Node.js 22.19.0+, Python 3.11+ and uv on Linux. Run `sh scripts/setup.sh dsh` to install both tool and Web dependencies. The complete validation commands are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

Use an isolated runtime and test workspaces. Native model fixtures exercise configuration and sessions without calling a paid provider. Real model or device installation checks should use separate accounts and state directories, with their coverage recorded explicitly.

## Pull requests

Keep one main change per branch and PR. Describe the triggering problem, final behavior, validation commands and results, compatibility effects, and any remaining limitations. Changes to state or execution routing should explain how identity, ownership and retries remain correct.

Pi supplies the native tools. Prefer its public definitions over reimplementing file editing, search or shell behavior. Keep DSH patches version checked; an upstream upgrade must verify the actual frontend, session events, file routing and input ownership.

## Private data

Keep runtime directories, provider credentials, device keys and Web launch URLs outside Git. `scripts/check_release.py` checks source inputs and optionally all referenced Git history. Review new files and sample configuration manually before opening a PR.

Contributions are licensed under the repository's [MIT license](LICENSE). Dependencies retain their original licenses and notices.
