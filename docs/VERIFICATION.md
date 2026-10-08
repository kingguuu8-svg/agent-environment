# 验证

验证覆盖实际工具效果和会话状态。常规开源检查使用隔离的 SSH、工作区和 DSH Host，模型地址指向不可用的本地占位端口，流程中没有真实模型请求。

## 可重复检查

Linux 上安装 OpenSSH 服务端，并确保 `sshd` 可以由当前非 root 用户启动隔离实例。测试会生成临时主机密钥与客户端密钥，监听 loopback，保持系统实际 SSH 配置。

```bash
sh scripts/setup.sh dsh
uv run ruff check .
node worker.mjs --check-manifest
.venv/bin/python verify_platform.py --dsh
.venv/bin/python verify_environment_access.py
.venv/bin/python verify_device_onboarding.py
node verify_dsh_sidebar.mjs
python3 scripts/check_release.py --history
python3 scripts/build_release.py
```

`verify_platform.py` 启动两套真实 SSH 目标，从通用 CLI 初始化独立 Environment，调用 HTTP 与官方 MCP SDK，检查跨设备文件效果、错误凭据、重复 Host 拒绝与重启恢复。`--dsh` 还检查通用模型目录、原生会话创建、机器切换、草稿和输入权恢复。省略该选项可在仅安装 Environment 依赖的源码包上运行。

`verify_environment_access.py` 验证 Host 持有的环境，覆盖全部七个 Pi 工具、图片和编辑数据、请求边界、取消、并发、凭据撤销、错误状态和现有会话保持。`verify_device_onboarding.py` 验证配对权限、重复与并发安装、过期、恢复以及三个操作系统安装包的结构。

`verify_platform.py --dsh --asset-dir /path/to/asset-cache` 可以复用已经下载的官方 fd 归档，准备时仍核对 SHA256。复用依赖缓存与复用个人运行时是不同的验证条件；记录验证结果时应说明资源来源。

`--node` 和 `--npm` 可以指定目标上的可执行文件。特殊 npm 安装可以传入 npm 的 `npm-cli.js` 路径；安装脚本也支持 `AGENT_NODE`、`AGENT_NPM`。

## 源码包验证

发布包只包含检查通过的源码文件、依赖锁文件和文档，同时生成 SHA256 文件与源码清单。解压包后重新运行 `scripts/setup.sh` 和上述验证，确认它在没有 Git、既有依赖和个人配置的目录中能启动。

检查器拒绝私有运行时路径、源文件符号链接，以及可识别的私钥、部分供应商密钥、Web token 和 JSON 凭据。历史检查遍历当前所有 Git 分支引用的提交。这些检查与人工审阅配合使用，敏感信息的其他格式仍需审阅。

GitHub Actions 分别安装 Environment 和 DSH，运行相应的隔离验证，并在 DSH 验证通过后构建源码包。CI 测试使用临时资源，GitHub 仓库和实际服务器的模型密钥均无需配置。

## 覆盖范围

当前环境可以验证 Linux 原生 Host 和 Linux SSH 工具。macOS、Windows 的安装脚本和包结构可以检查，原生安装体验还需要对应系统验证。真实模型接入、图像输入和各个模型能力需要供应商配置后的独立验证；通用部署测试确认配置被原生模型目录接受。

旧版本的完整验证记录保存在 [VALIDATION.md](../VALIDATION.md)，它用于理解已有功能覆盖。当前代码的交付证据应重新生成，不能仅引用旧结果。
