# Remote Pi MCP tools

这个原型让 Pi agent 会话绑定一个远端工作区。对话和模型配置保存在 agent 所在机器，文件、搜索与命令工具运行在 SSH 目标机器，项目指令也从目标目录读取。原有多机器 MCP 网关继续提供带机器前缀的工具。

~~~text
MCP 客户端 / agent
        │ stdio 或 Streamable HTTP
        ▼
Python MCP 网关
        │ SSH：安装依赖、启动、转发 MCP
        ▼
Node.js MCP 工具进程 → Pi 工具库 → 目标机器
~~~

## 远端工作区会话

remote-agent.mjs 使用 Pi SDK 创建会话，并用远端 MCP 实现替换 read、write、edit、bash、grep、find、ls。模型直接使用这七个原生名称。workspace_gateway.py 的一个进程固定绑定一台机器和一个目录，目录必须已存在；两个会话可以各自绑定同一机器上的不同项目。

安装依赖并配置 targets.json 后启动：

~~~bash
uv sync --python 3.12
npm ci
node remote-agent.mjs --config targets.json --machine devbox --workspace /srv/my-project --model your-provider/your-model
~~~

模型认证与自定义模型沿用 agent 所在机器的 Pi 配置目录，默认是 ~/.pi/agent，也可用 --agent-dir 指定。--workspace 使用目标机器上的路径；相对路径以目标登录用户的 home 为起点。输入 /exit 结束交互。启动器使用仓库 .venv/bin/python 启动网关，--python 可指定其他已安装 MCP 依赖的 Python。

启动时打印远端工作区 URI 和会话文件路径。恢复会话时传入该文件：

~~~bash
node remote-agent.mjs --config targets.json --machine devbox --workspace /srv/my-project --session /path/to/saved-session.jsonl
~~~

会话记录保存机器、SSH 地址与端口、规范化目录和 URI。恢复时检查这些字段，目录或机器改变会拒绝继续。--state-dir 可指定对话保存目录，默认是 ~/.local/share/remote-mcp-demo/agent。会话文件复用 Pi 的 JSONL 格式；同一个文件按单进程使用，不同会话可以并行运行。

Pi 在目标机器上按上游规则加载项目与祖先目录中的 AGENTS.md、AGENTS.override.md 或 CLAUDE.md，以及目标用户的 Pi 全局指令。工作区身份、Git 根目录、分支和变更状态通过 workspace://context 资源返回。每轮用户请求前刷新这些数据；连接失败时停止该轮请求。文件引用带 ssh:// 地址，以保留机器和目录身份。

单次执行与检查上下文：

~~~bash
node remote-agent.mjs --config targets.json --machine devbox --workspace /srv/my-project --prompt '检查这个项目并运行测试' --json
node remote-agent.mjs --config targets.json --machine devbox --workspace /srv/my-project --inspect
~~~

其他 MCP 客户端可以直接接入工作区专属入口：

~~~bash
uv run python workspace_gateway.py --config targets.json --machine devbox --workspace /srv/my-project
~~~

该入口也支持 --transport http 和 --port。客户端需要主动读取 workspace://context 并将其加入模型上下文；remote-agent.mjs 已完成这一步。MCP 入口固定工具的执行位置，客户端负责会话与上下文绑定。

当前启动器提供文本交互和单次执行。远端 Pi 的 skills、扩展、提示模板与 .pi/settings.json 尚未接入；远端文件 URI 保留定位信息，编辑器打开这些 URI 的操作还需要客户端支持。

## 工具来源

工具包固定使用 [Pi](https://github.com/earendil-works/pi) 的 @earendil-works/pi-coding-agent@1.0.2，通过公开的 create*ToolDefinition 工厂创建 read、write、edit、bash、grep、find、ls。目标进程独立执行这些工具，无需模型配置或 Pi agent 会话。package-lock.json 固定完整依赖树。

worker.mjs 负责把 Pi 定义转换为 MCP 接口：工具名、参数结构和输出结构沿用上游，promptGuidelines 加入工具描述。输入先经过 Pi 的 prepareArguments，再使用 TypeBox 验证。content、structuredContent、isError 原样返回，Pi 的 details 保存在 MCP 结果的 _meta["pi/details"] 中，包含编辑 diff、patch 和截断信息。请求取消连接到 Pi 的 AbortSignal；提供 progressToken 的客户端可以接收 bash 进度通知。

machine_info 是附加的诊断工具，返回目标主机、worker PID、工作区、Node 版本及 Pi 包版本。网关提供 list_machines、connect_machine、disconnect_machine 三个管理工具。

远端工具使用机器名前缀，例如 devbox__read。网关启动时读取 pi-tools.json 公布预选工具包的契约，连接后使用目标进程返回的真实定义。pi-tools.json 由 worker.mjs 从上游定义生成，部署时和集成测试都会检查一致性；工具列表变化继续发送 tools.listChanged 通知。

## 本机验证

网关需要 Python 3.11+；目标机器需要 Python 3.11+、Node.js 22.19.0+ 和 npm。首次安装需要访问 npm 包索引。Pi 的 grep、find 使用 ripgrep、fd；缺少时由 Pi 自动下载，下载需要 GitHub 可达。

在有 OpenSSH 客户端和 sshd 的 Linux 上执行：

~~~bash
uv sync --python 3.12
npm ci
node worker.mjs --check-manifest
uv run python verify_local.py
uv run python verify_workspace_local.py
~~~

verify_local.py 会启动独立 loopback sshd，使用临时 SSH 密钥和全新目标目录验证部署、全部 Pi 工具、图片、编辑边界、并发编辑、截断、进度、超时、取消、断开和恢复。结束后清理测试进程与目标目录，结果保存为 .local/verification-local.json。可用 --node 和 --npm 指定目标使用的可执行文件。

verify_workspace_local.py 检查两个并行工作区、指令与 Git 上下文、工具执行位置、取消、会话保存与恢复、错误目录和 worker 重连。它使用真实 SSH、MCP 和 Pi 会话存储，模型调用留给 VPS 验证。

依赖版本或工具选项改变后，重新生成并检查契约：

~~~bash
node worker.mjs --manifest > pi-tools.json
node worker.mjs --check-manifest
~~~

## 连接自己的机器

复制 targets.example.json 为 targets.json，填入已有 SSH 别名或登录地址：

~~~json
{
  "targets": {
    "devbox": {
      "host": "user@your-machine",
      "python": "python3.11",
      "node": "node",
      "npm": "npm",
      "workspace": ".local/share/remote-mcp-demo/workspace"
    }
  }
}
~~~

python 用于 SSH 部署脚本，node 用于运行工具，npm 用于安装依赖，均可指定目标上的绝对路径。npm_registry 默认是 https://registry.npmjs.org。首次连接会在 remote_base 下写入工具包并执行 npm ci；再次连接会检查安装标记、源文件和真实工具契约，复用完整安装。

网关复用 OpenSSH 配置、known_hosts 和 SSH agent，也可通过 identity_file 指定本机密钥路径。目标主机密钥需要提前登记。

启动 HTTP 入口：

~~~bash
uv run python gateway.py --config targets.json --transport http --port 8765
~~~

MCP 客户端接入 http://127.0.0.1:8765/mcp，先调用 connect_machine，再调用目标工具。网关默认监听 loopback；跨机器接入可通过 SSH 端口转发访问。

支持 stdio 的客户端可以直接启动：

~~~bash
uv run python gateway.py --config targets.json
~~~

## 两台 VPS 验证

复制 vps-check.example.json 到 .local/vps-check.json，填写网关与目标的 SSH 登录地址和本机密钥路径，然后执行：

~~~bash
uv run python verify_vps.py --config .local/vps-check.json
~~~

脚本将网关文件安装到网关用户的 ~/.local/share/remote-mcp-demo，以临时 SSH agent 转发目标登录能力，通过本机 SSH 端口转发访问 HTTP MCP。目标工具包由 connect_machine 自动安装。结束后关闭网关进程和临时 SSH agent，删除目标测试目录；网关文件及 Python 环境保留供再次使用。

已有 OpenCode 和模型配置时，可同时检查真实 agent 对全部 Pi 工具的调用：

~~~bash
uv run python verify_vps.py --config .local/vps-check.json --agent-model your-provider/your-model
~~~

检查从目标未连接的状态开始，要求 OpenCode 连接机器，写入、编辑、读取并搜索目标文件，随后执行命令确认主机。权限仅开放 demo 的 MCP 工具。脚本独立读取目标文件复核结果，报告位于 .local/verification-vps.json，客户端记录位于 .local/agent-check。

让 Pi agent 实际运行在网关 VPS，并绑定目标 VPS 的工作区：

~~~bash
uv run python verify_workspace_vps.py --config .local/vps-check.json --agent-model your-provider/your-model
~~~

这个验证脚本读取本机已有的 OpenCode OpenAI-compatible provider 配置，临时为 VPS 上的 Pi 配置同一模型。SSH 私钥保留在本机，模型 API 凭据经 SSH 传入远端进程环境，临时 models.json 只保存环境变量引用。脚本检查模型读取远端项目指令并使用全部七个工具，同时复核目标文件内容和 CLI 的对话恢复。报告位于 .local/verification-workspace-vps.json；临时配置、会话、工作目录和测试进程在结束时清理。

## 生命周期与执行权限

工具进程跟随 SSH 连接运行。重复连接复用已就绪的后端，同一目标的并发连接串行处理；工具进程退出后，网关保留契约和管理入口，再次连接恢复执行。工作文件和安装包留在目标机器，网关连接状态保存在内存中。

断开机器会先取消正在执行的调用，再关闭 SSH 连接；等待结果的客户端收到断开错误。MCP 请求超时也会转发取消通知。worker 在 stdin 结束或收到退出信号时关闭 MCP 服务，由 Pi 的 AbortSignal 清理子进程。

workspace 是 Pi 工具的默认工作目录。文件工具支持绝对路径、上级目录和符号链接，文件与命令访问权限由 SSH 登录用户决定。bash 每次执行独立 shell，跨调用的目录与环境需要在命令中显式指定。HTTP 入口服务于能够访问该入口的客户端。

当前适配范围覆盖 Linux 目标上的 Pi 工具、工作区上下文资源和 Pi SDK 会话。启动器退出会关闭自己拥有的 stdio 网关与远端 worker；HTTP 网关的生命周期由启动它的进程管理。工作区入口会在 SSH 断开后的后续调用前尝试重连，已经发送且失败的调用返回错误，由 agent 判断后续操作。统一 agent 的常驻服务、终端 UI、持久 PTY 和其他 MCP 能力需要继续接入。
