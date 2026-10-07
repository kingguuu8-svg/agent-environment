# 云端会话

在目标机器的项目目录运行 pi --remote，当前目录会登记为本次入口的工作区。新会话默认在这个目录操作。VPS 4 的会话服务独立于终端连接运行，关闭界面后任务继续执行，记录仍保存在云端。

~~~text
机器 A 的 Pi 终端 ── SSH ──┐
                          ├── VPS 4 会话服务 → Pi SDK → 模型
机器 B 的 Pi 终端 ── SSH ──┘          │
                                     ├── VPS 4 本机 Pi 工具
                                     ├── SSH / MCP → A 的工作区
                                     ├── SSH / MCP → B 的工作区
                                     └── HTTP MCP → 其他服务
~~~

终端复用 Pi 的编辑器、消息与工具渲染、会话选择组件。模型配置与认证从 VPS 4 读取，目标机器只运行界面和工具。会话服务监听当前用户的 Unix socket，目录权限为 700，socket 权限为 600；SSH 负责跨机器认证与加密。

## 终端操作

| 操作 | 行为 |
| --- | --- |
| /resume | 选择当前入口工作区的云端会话 |
| /resume all | 搜索所有机器的会话，选择后接管输入权并保留原工作区 |
| /resume all --current | 选择会话并将默认工作区切换到本机当前目录 |
| /workspace | 选择默认工作区 |
| /workspace current | 使用启动 pi --remote 时的目录 |
| /takeover | 重新获得当前会话的输入权 |
| /fork | 从当前历史末尾创建独立会话 |
| /fork entry-id --current | 从指定历史节点分支，并使用本机当前目录 |
| /environment | 查看机器、工作区与 MCP 服务 |
| /cancel 或 Esc | 取消正在执行的任务 |
| /exit 或 Ctrl+D | 离开终端，会话与任务继续留在云端 |

同一会话由云端单进程执行和写记录。多个终端可以观看，默认只有一个终端能输入；接管后旧终端继续显示进度，并在提交指令时收到控制权已改变的错误。服务端检查连接身份和控制权版本，断线重连先同步状态，/reconnect 默认恢复观看，/takeover 再获得输入权。

工作区变化会写入历史。执行中的一轮固定使用开始时的工作区，期间提出的切换在结束后生效。普通 read、write、edit、bash、grep、find、ls 使用这个默认位置；cloud__bash、cloud__read 等固定操作 VPS 4。其他工作区使用各自的工具前缀，environment 工具让模型发现这些资源与对应项目指令。新增工作区后，下一轮更新模型的工具声明。

用户也可以从同一个输入框执行终端操作：!command 使用当前工作区，!@cloud command 使用 VPS 4，/tool tool-name JSON 调用任意已登记工具。工具结果进入同一会话。文件引用和执行结果保留机器身份，换终端时历史路径保持原来的含义。

Fork 复用 Pi 的原生分支存储，创建新的会话身份与历史文件。两个分支访问的实际文件仍然共享。运行中的任务需要结束或取消后再 fork，选择历史节点时会拒绝缺少工具结果的位置。

## 状态与恢复

cloud-service.mjs 持有每个会话的 Pi SDK 实例；cloud-client.mjs 和 cloud-bridge.mjs 转发终端请求和事件；environment.mjs 管理工作区身份、连接与工具声明。模型循环、编辑、搜索、命令执行和上下文整理使用 Pi 的实现。

服务为每轮任务保存唯一编号和结果，重复提交返回已有状态。连接丢失后的命令保持失败状态，由下一轮决定后续操作。最近结果保存于发现数据，完整任务编号保留在 Pi 日志中，较早编号再次提交会被拒绝。

服务重启从 Pi 日志恢复工作区、模型和历史，将未记录最终结果的任务标记为 interrupted，保留结果未知的说明。Pi 日志已保存的最终结果优先于尚未更新的发现数据。进程被强制终止后，写入锁在约 10 秒后过期；部署服务的重启间隔为 12 秒。

会话 JSONL、发现数据和环境清单保存在 --state-dir 中。一个状态目录由一个服务持有写入锁。工具连接由服务管理，终端退出只释放自己的输入权。取消请求仅影响本次调用，同一工作区上的其他会话继续执行。

## 安装与运行

当前 demo 已在 VPS 4 启动常驻服务，VPS 1 可以直接体验：

~~~bash
cd /root/remote-pi-demo
pi --remote
~~~

在 VPS 4 的任意已有目录运行 pi --remote，再使用 /resume all 选择 VPS 1 的会话，即可接管同一份历史。默认工作区继续位于 VPS 1；/workspace current 才将它切换到这次入口的目录。

先在云端安装仓库依赖，配置可从云端 SSH 登录的 targets.json，并使用已有 Pi 模型配置启动服务：

~~~bash
uv sync --python 3.12
npm ci
node cloud-service.mjs --config targets.json --model your-provider/your-model
~~~

默认数据目录是 ~/.local/share/remote-mcp-demo/cloud，模型目录是 ~/.pi/agent。可用 --state-dir、--agent-dir、--cloud-workspace 和 --python 指定路径。云端工作区默认使用数据目录。Unix socket 位于数据目录，较长路径需要改用较短的 --state-dir。

目标机器安装同一仓库的 Node 依赖，然后根据 client.example.json 配置 SSH 入口。machine 使用 targets.json 中的机器名。安装器保存入口配置并安装 Pi 命令：

~~~bash
python3 install-client.py --profile client.json
cd /path/to/project
~/.local/bin/pi --remote
~~~

将 ~/.local/bin 加入 PATH 后可以直接输入 pi --remote。pi 的普通参数继续交给上游 Pi CLI。安装器发现同名已有命令时会要求选择其他 --bin-dir，保留用户已有入口。

VPS 1 与 VPS 4 的完整部署由脚本完成：

~~~bash
uv run python deploy_cloud_vps.py --config .local/vps-check.json --agent-model your-provider/your-model
~~~

脚本在 VPS 4 安装用户级 remote-pi.service 并开启 linger，在 VPS 1 安装终端入口。root 用户的入口安装在 /usr/local/bin，普通用户使用 ~/.local/bin。两台机器分别生成专用 SSH 密钥，原有登录私钥留在本机。VPS 1 进入云端的密钥只允许连接会话桥接进程。模型配置使用云端权限为 600 的环境文件与配置文件。

云端可在配置中额外登记 HTTP MCP 服务：

~~~json
{
  "targets": { "devbox": { "host": "user@your-machine", "workspace": "/srv/project" } },
  "mcp": { "archive": { "url": "http://127.0.0.1:9000/mcp" } }
}
~~~

其工具以 archive__tool-name 暴露给模型，参数与结果沿用原 MCP 定义。需要认证时，可在该服务配置中设置 headers。MCP 服务加入环境清单，目录类型的工作区承担默认文件操作位置。

## 验证与运行范围

~~~bash
uv run python verify_cloud_local.py
uv run python verify_cloud_vps.py --config .local/vps-check.json --agent-model your-provider/your-model
uv run python verify_deployed_vps.py --config .local/vps-check.json
~~~

验证覆盖多端控制、默认与显式工作区、分支、共享连接取消、断线继续运行、重复提交、不可用目标、正常重启与进程被强制终止后的恢复。本机还使用真实 SSH PTY 检查 Pi 编辑器、重连、会话选择与工具渲染，并接入额外 HTTP MCP 工具。报告保存在 .local/verification-cloud-local.json、.local/verification-cloud-vps.json 和 .local/verification-cloud-deployment.json，验收说明见 [验证记录](VALIDATION.md)。

当前范围是单用户 Linux、云端可直接 SSH 登录的目标和 HTTP MCP 工具。终端复用 Pi 的主要界面组件；文件补全、图片粘贴、完整 Pi 命令集、远端 skills 与扩展尚未接入。新提示在当前任务结束后提交，任务进行中可以接管、取消和安排工作区切换。后台会话需要 VPS 4 服务持续运行，工作区工具需要对应机器在线。

停止常驻服务可在 VPS 4 执行 systemctl --user disable --now remote-pi.service。会话数据保留在 cloud 目录；终端入口、专用 SSH 密钥及其 authorized_keys 记录可以按安装路径移除。原有单工作区启动器与 MCP 网关继续独立使用。
