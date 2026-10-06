# Remote MCP demo

这个原型让 agent 通过一个常驻 MCP 网关，接入 SSH 机器上的原生工具。首次连接会安装工具包，随后由 SSH 启动 stdio MCP 进程，网关发现并转发它的工具。

~~~text
MCP 客户端 / agent
        │ stdio 或 Streamable HTTP
        ▼
常驻网关
        │ SSH：检查、安装、启动、MCP 通信
        ▼
目标机器上的 MCP 工具进程
~~~

网关提供三个管理工具：list_machines、connect_machine、disconnect_machine。预选工具包的 machine_info、read_file、write_file、edit_file、run_command 在启动时就公布描述和参数结构，调用 connect_machine 后具备执行能力。

远端工具使用机器名前缀，例如 devbox__read_file。描述、输入与输出 schema、annotations 保留原值；调用结果直接转发，包括 structuredContent、content 和 isError。连接成功后，网关读取远端真实工具列表，使用其定义转发调用。

描述提前公布的原因是客户端兼容性：协议客户端能够接收 tools.listChanged；实测 OpenCode 1.18.29 在同一轮任务里没有把新增工具提供给模型。这个原型的部署包已经确定，网关可以先从同一份 SDK 工具定义获取接口契约，连接只改变执行状态。工具包契约需要与目标上的实际工具保持一致。

## 本机验证

准备 Linux、Python 3.11+、OpenSSH 客户端与 sshd，然后执行：

~~~bash
uv sync --python 3.12
uv run python verify_local.py
~~~

脚本在 loopback 上启动独立 sshd，生成临时密钥，使用全新目标目录完成首次部署。它验证实际文件内容、命令执行位置、拒绝越界访问、超时、进程退出、并发连接和恢复。结束后关闭测试进程并删除临时目录。验证结果保存在 .local/verification-local.json。

## 连接自己的机器

复制 targets.example.json 为 targets.json，并填入已有 SSH 别名或登录地址：

~~~json
{
  "targets": {
    "devbox": {
      "host": "user@your-machine",
      "python": "python3.11",
      "workspace": ".local/share/remote-mcp-demo/workspace"
    }
  }
}
~~~

网关复用 OpenSSH 配置、known_hosts 和 SSH agent，也可通过 identity_file 指定本机密钥路径。SSH 主机密钥必须已经登记，首次安装需要目标的 Python venv、pip 和包索引可达。python 默认是 python3，可指定目标上的其他解释器。index_url 默认是 https://pypi.org/simple，可为目标指定可达的包索引。

启动 HTTP 入口：

~~~bash
uv run python gateway.py --config targets.json --transport http --port 8765
~~~

在支持 Streamable HTTP 的 MCP 客户端中配置 http://127.0.0.1:8765/mcp。网关默认监听 loopback；跨机器接入可通过 SSH 转发访问。

支持 stdio 的客户端可以直接启动：

~~~bash
uv run python gateway.py --config targets.json
~~~

## 两台 VPS 验证

复制 vps-check.example.json 到 .local/vps-check.json，填入网关和目标的登录地址、原有本机密钥路径。host 使用实际主机名或 IP，以匹配本机 known_hosts 记录。

~~~bash
uv run python verify_vps.py --config .local/vps-check.json
~~~

脚本将网关安装在登录用户的 ~/.local/share/remote-mcp-demo，使用临时 SSH agent 转发目标登录能力，并通过本机 SSH 端口转发访问 HTTP MCP。目标工具包由 connect_machine 自动安装。测试结束后，目标临时目录、授权 agent 和本次网关进程会关闭；网关程序及独立 Python 环境留在 VPS 上供再次使用。

已有 OpenCode 和模型配置时，可以同时验证真实 agent 的首次连接体验：

~~~bash
uv run python verify_vps.py --config .local/vps-check.json --agent-model your-provider/your-model
~~~

这个检查从后端未连接的状态开始，要求 OpenCode 自己连接目标，然后调用文件与命令工具。客户端在独立测试目录运行，权限仅开放 demo 的 MCP 工具。脚本还会独立读取目标文件，检查 agent 实际写入的内容。结果保存在 .local/verification-vps.json，客户端记录位于 .local/agent-check。

## 生命周期与权限

工具进程跟随 SSH 连接运行；网关关闭时会关闭后端。远端进程异常退出后，网关拒绝执行调用并保留工具契约和管理入口，再次调用 connect_machine 可恢复。重复连接复用已就绪的后端，同一目标的并发连接串行处理。

工作文件和已安装工具包存储在目标机器上。网关连接状态保存在内存中，网关重启后重新连接即可。Agent 的对话和任务状态由接入的 agent 自己保存。

文件工具将路径限制在 workspace 内，并检查符号链接的实际位置。run_command 使用 SSH 登录用户的操作系统权限，workspace 只决定它的启动目录。HTTP 入口服务于能够访问该入口的客户端。

目前实现集中在 MCP tools 的部署、发现和转发，适用于单个用户的探索验证。浏览器、GUI、resources、prompts 和跨客户端的批准交互需要相应目标工具包与后续适配。
