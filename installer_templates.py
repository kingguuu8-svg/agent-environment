"""OS entry scripts for a private, self-contained device installer."""

EXTRACT = r"""
"$python_bin" - "$tmpdir" <<'REMOTE_DSH_BUNDLE'
import base64,json,pathlib,sys,zlib
package=json.loads(zlib.decompress(base64.b64decode("__PACKAGE__")))
base=pathlib.Path(sys.argv[1])
for name,content in package.items():
 if pathlib.PurePosixPath(name).name!=name: raise ValueError("Invalid installer file")
 (base/name).write_text(content)
REMOTE_DSH_BUNDLE
"$python_bin" "$tmpdir/device_installer.py" --source "$tmpdir" "$@"
"""

LINUX = (
    r"""#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then printf '请在 Linux 运行此安装包。\n' >&2; exit 1; fi
missing=()
command -v python3 >/dev/null || missing+=(python3)
command -v ssh >/dev/null || missing+=(openssh-client)
command -v tar >/dev/null || missing+=(tar)
command -v curl >/dev/null || missing+=(curl)
if [ "${#missing[@]}" -gt 0 ]; then
  printf '正在安装系统依赖：%s\n' "${missing[*]}"
  admin=(); if [ "$(id -u)" != 0 ]; then admin=(sudo); fi
  if command -v apt-get >/dev/null; then
    "${admin[@]}" apt-get update
    "${admin[@]}" apt-get install -y "${missing[@]}"
  elif command -v dnf >/dev/null; then
    "${admin[@]}" dnf install -y python3 openssh-clients tar curl
  elif command -v pacman >/dev/null; then
    "${admin[@]}" pacman -S --needed --noconfirm python openssh tar curl
  else
    printf '请先安装 Python 3.11+、OpenSSH 客户端、tar、curl，再运行此文件。\n' >&2; exit 1
  fi
fi
python_bin=$(command -v python3)
for candidate in python3 python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
    python_bin=$(command -v "$candidate"); break
  fi
done
if ! "$python_bin" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'; then
  runtime_dir="$HOME/.local/share/remote-dsh-device/runtime"
  mkdir -p "$runtime_dir"
  if [ ! -x "$runtime_dir/uv" ]; then
    curl -fsSL https://astral.sh/uv/install.sh -o "$runtime_dir/install-uv.sh"
    UV_INSTALL_DIR="$runtime_dir" UV_NO_MODIFY_PATH=1 sh "$runtime_dir/install-uv.sh"
  fi
  if ! python_bin=$(UV_PYTHON_INSTALL_DIR="$runtime_dir/python" "$runtime_dir/uv" python find --managed-python --no-python-downloads 3.12 2>/dev/null); then
    UV_PYTHON_INSTALL_DIR="$runtime_dir/python" "$runtime_dir/uv" python install 3.12
    python_bin=$(UV_PYTHON_INSTALL_DIR="$runtime_dir/python" "$runtime_dir/uv" python find 3.12)
  fi
fi
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
"""
    + EXTRACT
)

MAC = (
    r"""#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then printf '请在 macOS 运行此安装包。\n' >&2; exit 1; fi
python_bin=$(command -v python3 || true)
if [ "$python_bin" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then python_bin=''; fi
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
if [ -z "$python_bin" ] || ! "$python_bin" -c 'import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)'; then
  printf '正在安装官方 Python，系统会请求管理员密码。\n'
  curl -fsSL https://www.python.org/ftp/python/3.13.7/python-3.13.7-macos11.pkg -o "$tmpdir/python.pkg"
  pkgutil --check-signature "$tmpdir/python.pkg" >/dev/null
  sudo /usr/sbin/installer -pkg "$tmpdir/python.pkg" -target /
  python_bin=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3
fi
"""
    + EXTRACT
)

WINDOWS = r"""$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
  if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请以管理员运行一次安装器，以启用 Windows OpenSSH 客户端。'
  }
  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null
}
$root = Join-Path $env:LOCALAPPDATA 'RemoteDSH'
New-Item -ItemType Directory -Force $root | Out-Null
$python = Join-Path $root 'Python\python.exe'
if (-not (Test-Path $python)) {
  foreach ($name in @('python3.exe','python.exe')) {
    $candidate = Get-Command $name -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Source -notlike '*\WindowsApps\*') {
      & $candidate.Source -c 'import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>$null
      if ($LASTEXITCODE -eq 0) { $python = $candidate.Source; break }
    }
  }
}
if (-not (Test-Path $python)) {
  Write-Host 'Installing official Python in the current user directory...'
  $setup = Join-Path $root 'python-setup.exe'
  Invoke-WebRequest 'https://www.python.org/ftp/python/3.13.7/python-3.13.7-amd64.exe' -OutFile $setup
  if ((Get-AuthenticodeSignature $setup).Status -ne 'Valid') { throw 'Python installer signature check failed' }
  $destination = Join-Path $root 'Python'
  $process = Start-Process $setup -ArgumentList @('/quiet','InstallAllUsers=0','Include_test=0','Include_pip=0','Include_launcher=0','PrependPath=0',('TargetDir="' + $destination + '"')) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Python setup did not complete' }
  Remove-Item $setup
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory $temporary | Out-Null
try {
  $bundle = Join-Path $temporary 'bundle.txt'
  [IO.File]::WriteAllText($bundle, '__PACKAGE__')
  $decode = 'import base64,json,pathlib,sys,zlib; p=json.loads(zlib.decompress(base64.b64decode(pathlib.Path(sys.argv[2]).read_text()))); b=pathlib.Path(sys.argv[1]); assert all(pathlib.PurePosixPath(n).name==n for n in p); [(b/n).write_text(c,encoding=''utf-8'') for n,c in p.items()]'
  & $python -c $decode $temporary $bundle
  if ($LASTEXITCODE -ne 0) { throw 'Unable to extract installer' }
  & $python (Join-Path $temporary 'device_installer.py') --source $temporary @args
  if ($LASTEXITCODE -ne 0) { throw 'Device setup did not complete; run this installer again after fixing the error' }
} finally { Remove-Item -Recurse -Force $temporary }
"""
