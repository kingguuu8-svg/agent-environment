# DSH Remote Hub

给你的 Agent 一份跨设备的工作环境。一个常驻服务登记机器、工作区和 MCP 服务；Agent 可以保留自己的模型、会话和本地工具，通过同一个入口调用其他机器上的原生工具。

可选的 DSH Web 界面把模型和会话放在服务器上运行。在任意已接入设备的项目目录执行 `dsh web --remote`，浏览文件、继续会话或切换执行机器。工作区切换会进入下一次模型请求的真实上下文，同一会话继续使用已有历史。

[English](README.en.md) · [快速开始](docs/QUICKSTART.md) · [部署](docs/DEPLOYMENT.md) · [架构](docs/ARCHITECTURE.md)

## 两种入口

| 入口 | 适合的用法 | 模型与会话在哪里 |
| --- | --- | --- |
| Environment HTTP / MCP | 给现有 Agent 一个网址、账户和密钥，接入共享机器与工具 | 原 Agent |
| DSH Web | 从不同设备打开同一会话，切换机器和目录，接力输入 | 中心服务器 |

目标机器提供 Pi 的 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。工具实现来自固定版本的上游 Pi，协议适配保留图片、编辑差异、结构化结果和取消行为。额外 MCP 服务也可作为 Environment 资源接入。

## 开始使用

在 Linux 服务器或开发机准备 Node.js 22.19.0+、Python 3.11+、[uv](https://docs.astral.sh/uv/getting-started/installation/) 和 OpenSSH 客户端，然后获取源码并启动环境：

```bash
git clone https://github.com/kingguuu8-svg/dsh-remote-hub.git
cd dsh-remote-hub
sh scripts/setup.sh environment
mkdir -p "$HOME/agent-workspace"
python3 agent_environment.py init --workspace "$HOME/agent-workspace"
python3 agent_environment.py doctor
python3 agent_environment.py start
```

初始化生成 `.local/platform/connection.md`，包含网址、账户和随机密钥，文件权限为 600。把这个文件交给能够发起 HTTP 请求或连接 MCP 的 Agent，就可以使用服务器上的工作区。默认服务只监听本机；远程访问使用 SSH 转发或 HTTPS 代理。

要接入第二台机器，初始化时通过 `--targets targets.json` 指定已有 SSH 目标。完整的双机器任务和 DSH 安装步骤见[快速开始](docs/QUICKSTART.md)。

## 跨设备行为

- 每次 Environment 调用明确指定目标。相对路径跟随该目标工作区，Agent 的本地工具继续作用于本机。
- DSH 侧栏按主机、工作区和会话组织；文件浏览器跟随会话当前的执行位置。
- 多个窗口共享会话历史与文字草稿，通过输入权接力操作。切换工作区会刷新机器身份、目录、Git 摘要与项目指令。
- 目标设备可以通过 SSH 接入，也可以从 Web 下载安装器建立出站连接。设备离线时会话记录仍然保留。
- 超时和断线不会自动重放文件修改或命令。客户端需要先核对目标状态再决定是否重复执行。

## 当前状态

这是面向个人可信设备的早期版本。Linux Host、真实 SSH 工具和跨设备会话已经验证；macOS 和 Windows 设备安装包仍处于预览阶段。DSH 集成固定在 `0.2.0-rc.2`，部分功能通过有版本检查的安装后补丁实现。

账户能操作全部已登记资源，工具使用目标系统用户的权限。工作区定义默认执行目录；文件访问范围由操作系统权限决定。多 Agent 可以同时编辑相同文件，当前按文件的实际状态协作。

[验证方法](docs/VERIFICATION.md) · [贡献](CONTRIBUTING.md) · [权限与漏洞报告](SECURITY.md) · [MIT 许可](LICENSE) · [依赖说明](THIRD_PARTY_NOTICES.md)
