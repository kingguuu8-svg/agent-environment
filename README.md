# Remote Pi MCP tools

这个原型让 agent 通过一个 MCP 网关，使用 SSH 目标机器上的 Pi 工具。目标进程直接调用上游工具库；网关负责部署、连接、机器路由和 MCP 通信。

~~~text
MCP 客户端 / agent
        │ stdio 或 Streamable HTTP
        ▼
Python MCP 网关
        │ SSH：安装依赖、启动、转发 MCP
        ▼
Node.js MCP 工具进程 → Pi 工具库 → 目标机器
~~~

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
~~~

verify_local.py 会启动独立 loopback sshd，使用临时 SSH 密钥和全新目标目录验证部署、全部 Pi 工具、图片、编辑边界、并发编辑、截断、进度、超时、取消、断开和恢复。结束后清理测试进程与目标目录，结果保存为 .local/verification-local.json。可用 --node 和 --npm 指定目标使用的可执行文件。

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

## 生命周期与执行权限

工具进程跟随 SSH 连接运行。重复连接复用已就绪的后端，同一目标的并发连接串行处理；工具进程退出后，网关保留契约和管理入口，再次连接恢复执行。工作文件和安装包留在目标机器，网关连接状态保存在内存中。

断开机器会先取消正在执行的调用，再关闭 SSH 连接；等待结果的客户端收到断开错误。MCP 请求超时也会转发取消通知。worker 在 stdin 结束或收到退出信号时关闭 MCP 服务，由 Pi 的 AbortSignal 清理子进程。

workspace 是 Pi 工具的默认工作目录。文件工具支持绝对路径、上级目录和符号链接，文件与命令访问权限由 SSH 登录用户决定。bash 每次执行独立 shell，跨调用的目录与环境需要在命令中显式指定。HTTP 入口服务于能够访问该入口的客户端。

当前适配范围是 Linux 目标上的 MCP tools。Pi 的终端 UI、agent 会话、模型上下文、持久 PTY，以及 MCP resources、prompts、sampling、elicitation 需要相应运行时或额外适配。统一 agent 的常驻部署与对话状态由接入的 agent 客户端管理。
