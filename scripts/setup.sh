#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mode="${1:-environment}"
case "$mode" in environment|dsh) ;; *) echo 'Usage: sh scripts/setup.sh [environment|dsh]' >&2; exit 2 ;; esac
agent_node="${AGENT_NODE:-node}"
agent_npm="${AGENT_NPM:-npm}"
"$agent_node" -e 'const v=process.versions.node.split(".").map(Number);if(v[0]<22||v[0]===22&&v[1]<19)throw Error("Node.js >=22.19.0 is required")'
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python >=3.11 is required"'
command -v uv >/dev/null 2>&1 || { echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo 'Install the OpenSSH client first.' >&2; exit 1; }
# .js supports npm installations whose executable wrapper is outside PATH.
run_npm() {
  case "$agent_npm" in *.js) "$agent_node" "$agent_npm" "$@" ;; *) "$agent_npm" "$@" ;; esac
}
run_npm ci --no-audit --no-fund
uv sync --frozen
"$agent_node" worker.mjs --check-manifest
if [ "$mode" = dsh ]; then
  run_npm ci --prefix dsh-product --no-audit --no-fund
  "$agent_node" dsh-product/patch-dsh.mjs
fi
printf 'Installed %s dependencies. Run: python3 agent_environment.py init --help\n' "$mode"
