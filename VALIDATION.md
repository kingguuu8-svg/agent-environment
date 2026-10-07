# 验证记录

## DSH Web 产品

2026 年 10 月 7 日，DSH Web Host 已部署在 VPS4，VPS1 与当前电脑均已接入。真实模型使用 `cpa/gpt-6-sol`，工具使用锁定的 Pi 1.0.2；DSH 使用 0.2.0-rc.2。下面的结果对应 `feature/dsh-remote-workspaces` 分支。

| 验证对象 | 入口与环境 | 结果 |
| --- | --- | --- |
| 会话、排队切换、输入权、文件作用域 | `verify_dsh.py`，Agent 在 VPS4，目标 VPS1，真实模型 | 16 项通过 |
| 取消、目标离线、进程丢失、Host 重启 | `verify_dsh_recovery.py`，VPS4 与当前电脑，真实模型与实际服务停启 | 7 项通过 |
| 新 HTTP MCP 的发现与调用 | `verify_dsh_mcp.py`，独立 DSH Host、真实模型、临时 HTTP MCP 服务 | 2 项通过 |
| 既有 Pi MCP 工具行为 | `verify_local.py`，独立 loopback sshd | 23 项通过 |
| 既有远端工作区入口 | `verify_workspace_local.py`，两个并行目录与 HTTP MCP | 11 项通过 |

会话验证检查执行中保持旧目标、撤回与重新安排切换、旧版本选择被拒绝，以及切换前已经排队的消息在新目标执行。重复提交同一请求编号后，目标文件只追加一行。非法目录保留旧绑定，原生文件预览拒绝工作区外路径。原生 fork 继承历史和绑定，输入权独立；接管后旧窗口的提交被拒绝，原生 prompt API 也无法绕过控制权。

恢复验证实际停止本机反向 SSH 服务，检查文件读取、目录选择和工作区切换均被拒绝，云端仍能读取自己的文件。目标恢复后，原文件侧栏通过同一绑定重新工作。另一个检查只终止 DSH 自己的云端文件 worker，后续请求重新连接，无需先运行模型。

HTTP MCP 验证使用随机工具名，提示词只描述需要的功能。模型通过 `environment` 首次发现实际工具契约，调用该工具后写入结果；服务端调用记录与工作区文件独立复核通过。显式调用额外服务后，会话的默认工作区保持原值。

重启检查让远端命令先追加一次记录，再等待；保存待切换目标后重启 VPS4 Host。原生会话恢复到该目标，旧输入权失效，已追加记录仍为一行，命令后半段没有执行。插件事件携带 DSH 的 `ignorable` 外层字段，绑定与控制权操作使用原生 `sessions.flush` 作为持久化检查点。早期演示日志经过带原件备份的修复，已有跨机器对话恢复并保留完整内容。

实际 Web 操作从本机目录新建会话，由模型写入并读回 `ui-proof.txt`，随后通过目录选择组件将同一会话切到 VPS1，写入并读回 `ui-vps1-proof.txt`。模型保留上一轮操作本机的上下文，文件侧栏切到 VPS1 的目录。Host 多次重启后，该对话仍可打开。两个 Web 窗口检查共享历史、只读输入与接管；文件预览使用原生侧栏。

启动验证检查本机重复执行 `dsh web --remote` 复用后台服务、使用不同目录的入口提示，并在 CLI 退出后继续访问已认证的 Web API。Host 重启后命令获取新登录信息。VPS1 的已安装入口通过专用受限 SSH 密钥建立实际 Web 转发，返回 VPS1 的目录提示并完成原生登录。本机普通 `dsh --version` 保持可用。设备重复安装复用身份；更换机器编号、端口以及非法输入在修改配置前被拒绝。

复现本次本机工具与 DSH 检查：

```bash
.venv/bin/python verify_local.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
.venv/bin/python verify_workspace_local.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
dsh web --remote --no-open
.venv/bin/python verify_dsh.py --url-file /home/kingguuu8/.cache/remote-dsh/a36ca3ce857334ca.json --origin http://127.0.0.1:3081
.venv/bin/python verify_dsh_recovery.py --config .local/vps-check.json --url-file /home/kingguuu8/.cache/remote-dsh/a36ca3ce857334ca.json --workspace .local/dsh-user-demo
.venv/bin/python verify_dsh_mcp.py --models .local/dsh-dev/models.json --model-env .local/dsh-dev/model.env
```

恢复脚本会暂时停止设备连接和重启 Host，应在空闲时运行。私有启动信息与完整验证记录位于忽略目录中。该版本验证了个人 Linux 环境；其他操作系统、多人权限隔离、远端扩展与持久交互式终端尚未覆盖。安装和维护方式见 [云端 DSH](DSH_REMOTE.md)。

## Pi 终端记录

云端 Pi 会话已部署在 VPS 4，VPS 1 和 VPS 4 的终端可以接入同一份历史。验证覆盖输入权接管、独立分支、工作区切换、终端断线、共享连接取消以及服务重启。真实模型同时操作 VPS 1 的项目与 VPS 4 的云端目录。验证日期为 2026-10-07。

## 云端会话结果

| 环境 | 验证入口 | 结果 |
| --- | --- | --- |
| 本机 Fedora、Node 22.23.2、Python 3.12.14，独立 loopback sshd 和额外 HTTP MCP | verify_cloud_local.py | 14 项通过，包含真实 SSH、PTY 界面与重连 |
| VPS 4 Pi SDK、Node 22.23.2、cpa/gpt-6-sol；VPS 1 工具目标 | verify_cloud_vps.py --agent-model cpa/gpt-6-sol | 13 项通过，模型调用全部七个默认工具和两个云端工具 |
| VPS 4 常驻 remote-pi.service；VPS 1 与 VPS 4 已安装的 pi 入口 | verify_deployed_vps.py | 6 项通过，包含跨机器恢复、重连、断线后继续执行和 systemd 重启 |

复现命令如下。本机原有 npm 存在依赖加载错误，loopback 验证使用独立 npm 10.9.8；VPS 使用已有 Node 与 npm。

~~~bash
uv run python verify_cloud_local.py --node /home/kingguuu8/.local/node/bin/node --npm '/home/kingguuu8/Desktop/main/codex fandai/remote-mcp-demo/.local/npm-clean/package/bin/npm-cli.js'
uv run python verify_cloud_vps.py --config .local/vps-check.json --agent-model cpa/gpt-6-sol
uv run python verify_deployed_vps.py --config .local/vps-check.json
~~~

完整结果分别保存在 .local/verification-cloud-local.json、.local/verification-cloud-vps.json 和 .local/verification-cloud-deployment.json。运行记录与配置均由 Git 忽略。

## 输入权与恢复

两个终端接入相同会话时，查看者获得相同历史与进行中工具的快照。接管增加输入权版本，服务端同时检查连接身份与版本；旧终端再次写入会被拒绝。服务目录持有单一写入锁，第二个服务进程无法使用相同状态目录，Unix socket 权限为 600。

在 A 的命令运行期间，B 接管输入并提出切换工作区。实际命令仍在 A 的原目录完成，下一轮默认工具才使用新的目录。带工作区前缀的工具继续操作指定位置。重复提交相同任务编号不会再次产生文件副作用。非法工作区和错误工具参数会失败，原文件保持完整。Fork 创建新的 Pi 会话身份和 JSONL 文件，子会话的新消息保持独立；两个分支访问的实际目录仍然共享。

取消测试记录真实 shell PID，并检查进程最终消失、完成标记没有生成。同一个工具连接上并行执行两个会话，取消其中一个后，另一个仍完成文件写入。回归验证还在工作区上下文准备阶段触发取消，确认它保留共享连接；此前这一情形会让另一个会话失败。

终端离开只释放输入权。测试在命令运行时关闭客户端，并让另一终端读取完成后的文件。另一条连接发送快照请求后，在尚未读取响应时断开，用于复现 SSH 桥接进程被终止的情况；readline 与 socket 的错误处理保持云端服务运行。真实 SSH 终端执行 /reconnect 后先恢复观看，再通过 /takeover 获得输入权并成功执行命令。旧 SSH 进程迟到的退出事件被限制在其自身连接内。

正常重启恢复同一会话、工作区、历史与新的输入权版本。测试让发现数据落后于 Pi 日志，确认最终结果以日志为准。SIGKILL 测试在命令产生副作用后终止服务，等待写入锁过期，重启后记录 interrupted。重复提交原任务编号保持该状态，命令没有被重放。未完成的工具调用补入结果未知的说明，后续操作可以检查实际文件。

目标不可用时，原会话仍可发现和查看，默认工作区保持原身份，云端工具仍成功执行。目标恢复后，后续调用读取原目录中的文件。本机还登记额外 HTTP MCP 服务，实际调用保留文本与 structuredContent，并检查其工具已经声明给 Pi SDK。

真实 PTY 通过 SSH 检查 Pi 编辑器、云端 bash、重连、工作区选择、原生会话选择和退出。双机模型验证检查 read、write、edit、bash、grep、find、ls、cloud__write 与 cloud__bash 的成功调用，独立读取文件确认内容；随后模型从同一会话历史回答已经验证的内容，未调用工具。部署验证从 VPS 1 的当前目录启动已安装的 pi --remote，再从 VPS 4 恢复相同会话，默认工作区继续位于 VPS 1。测试清理上次目标输出，独立读取新生成的文件，并检查服务 PID 在终端退出前后保持一致。

## 常驻部署

VPS 4 在 /home/ubuntu/.local/share/remote-mcp-demo 安装运行时，用户级 remote-pi.service 保持 active，并已开启 linger。会话、环境清单和发现数据位于 cloud 目录，云端工作区位于 cloud-workspace。模型配置位于 cloud-pi，凭据环境文件权限为 600。

VPS 1 在 /root/.local/share/remote-mcp-demo 安装运行时，入口位于 /usr/local/bin/pi，兼容入口保留在 /root/.local/bin/pi。验证目录 /root/remote-pi-demo、云端会话和两个工作区中的终端证明文件保留，便于直接体验。

部署在各自机器上生成专用 SSH 密钥，仅交换公钥。VPS 1 进入 VPS 4 的密钥使用强制命令，只能运行 cloud-bridge。云端操作 VPS 1 的密钥开放目标登录用户的工具权限；文件与命令遵循该用户的权限。原有登录私钥留在本机，主机密钥使用已有 known_hosts 记录。停止服务可执行 systemctl --user disable --now remote-pi.service，会话数据继续保留。使用方法见 [云端会话](CLOUD_SESSIONS.md)。

## 既有功能验证

云端服务复用原有工作区网关与上游 Pi 工具。本次分支的兼容验证中，verify_local.py 的 23 项和 verify_workspace_local.py 的 11 项均通过。以下保留此前相应版本的单工作区与双机验证证据。

| 环境 | 验证入口 | 结果 |
| --- | --- | --- |
| 本机 Fedora，Python 3.12.14，Node 22.23.2，独立 loopback sshd | verify_local.py，stdio MCP | 23 项通过 |
| VPS 4 网关，Python 3.12；VPS 1 工具目标，Python 3.11.13、Node 22.22.3 | verify_vps.py，HTTP MCP 经 SSH 端口转发 | 23 项通过 |
| 本机 Pi SDK，两个并行项目，stdio 与 HTTP MCP | verify_workspace_local.py | 11 项通过，包含 CLI --url 检查与真实文件读取 |
| VPS 4 Pi SDK，Node 22.23.2、cpa/gpt-6-sol；VPS 1 两个工作区 | verify_workspace_vps.py --agent-model cpa/gpt-6-sol | 12 项通过，真实模型成功调用全部 7 个工具，CLI 恢复保存的模型与对话 |

此前的工具包版本 21faa88 还通过 OpenCode 1.18.29 的冷启动检查：10 次工具调用完成，全部 7 个 Pi 工具使用成功，目标文件独立复核通过。本次新增会话行为由 Pi SDK 和新启动器验证。

两种协议验证都使用全新目标目录，首次安装记录为 reused=false。目标通过 npm ci 安装锁定的依赖，并核对真实工具定义与 pi-tools.json。package-lock.json 的包地址统一使用官方 npm 索引；本机和 VPS 都验证了这些地址的安装。

本机已有 npm 在执行安装时出现依赖加载错误，验证使用独立 npm 10.9.8。实际复现命令为：

~~~bash
uv run python verify_local.py --node /home/kingguuu8/.local/node/bin/node --npm '/home/kingguuu8/Desktop/main/codex fandai/remote-mcp-demo/.local/npm-clean/package/bin/npm-cli.js'
uv run python verify_vps.py --config .local/vps-check.json
uv run python verify_workspace_local.py --node /home/kingguuu8/.local/node/bin/node --npm '/home/kingguuu8/Desktop/main/codex fandai/remote-mcp-demo/.local/npm-clean/package/bin/npm-cli.js'
uv run python verify_workspace_vps.py --config .local/vps-check.json --agent-model cpa/gpt-6-sol
~~~

VPS 验证使用其已有 Node 和 npm。网关通过专用临时 SSH agent 获取目标登录能力，原有私钥保留在本机；主机密钥沿用已有 known_hosts 记录。

## 工作区与会话

两个会话在同一 SSH 机器上绑定 alpha project 和 beta project，启动时共享同一个 Pi 工具安装包。安装锁串行处理首次部署。文件工具与 bash 使用各自的目录；并发写入同名 proof.txt 后，各项目保持独立内容，agent 本机目录没有生成该文件。

上下文资源返回机器与目录身份、Git 根目录和分支，并复用 Pi 的 loadProjectContextFiles 加载项目及祖先指令。验证向 agent 本机目录放入相反指令，确认它未进入项目上下文。修改目标 AGENTS.md 后，下一轮用户请求读取到 alpha-marker-v2。真实模型请求保存的系统上下文包含远端 URI，也替换了 Pi 默认提示中的本机文档路径。

会话文件复用 Pi 的 JSONL 存储，并保存远端绑定。关闭后恢复，按 JSON 格式比较完整对话，检查原文件内容和保存的模型。随后通过 CLI 的 --session 再次恢复，省略 --model；模型从历史中回答之前验证的 alpha-verified-v2 内容，未调用工具。

恢复到另一个工作区、打开不存在的会话文件，以及连接不存在的目标目录都会失败。错误目录不会被自动创建。worker 退出后的重连保持原绑定，已经失败的命令没有自动重放。取消测试检查目标 shell PID 已停止；Pi 的编辑参数准备、diff 和 MCP 进度也经过实际执行验证。

## 接口与文件操作

集成验证检查连接前的工具声明与调用拒绝、未知机器、SSH 认证失败、工具定义一致性、重复连接和并发连接。它还检查了真实目标文件的写入、读取、编辑与搜索结果。

编辑验证覆盖精确替换、失败后保持文件内容、非法参数、Pi 的参数准备函数、多个替换、BOM 与 CRLF、重叠与重复匹配，以及同一文件的并发编辑。编辑 diff 和 patch 通过 _meta["pi/details"] 保留。read 的图片内容块、文本截断信息与 offset 分页也通过实际调用验证。

Pi 的工作区作为默认目录，绝对路径、上级目录和符号链接保持上游行为。测试只操作临时目录中的文件，并验证这些路径可以访问；文件和命令操作使用目标 SSH 登录用户的权限。

## 命令与生命周期

bash 的输出目录和主机名对应目标机器。非零退出保留 isError 和结构化退出码；大量输出保留上游截断信息与完整输出文件路径，完整文件可在目标上继续读取。MCP 进度通知通过目标与网关两层转发到客户端。

超时与取消检查分别验证 Pi 的命令 timeout、MCP 请求超时、客户端主动取消，以及断开机器时的进行中调用。测试记录命令 PID，再确认进程已经停止。工具进程退出后，管理入口与契约继续存在；再次连接复用安装并保留文件。

补测曾发现断开连接后，原请求可能继续等待结果。现版由后端管理进行中的 RPC：先转发取消，再关闭会话，并向原调用返回断开错误。worker 在 stdin 结束和退出信号到来时关闭服务，由 Pi 处理子进程取消。上述行为已在本机与 VPS 上回归验证。

网关对 Python MCP SDK 1.26.0 补充了取消通知转发，并使用该版本的请求编号字段；升级 SDK 时需要复跑取消、超时和断开测试。

## Agent 调用

本次 Pi agent 在 VPS 4 使用普通工具名完成：

~~~text
write → edit → read / grep / find / ls / bash
~~~

它根据 VPS 1 的项目指令写入 model-proof.txt，将 marker 替换为 verified，再读取、搜索和定位文件，并确认目标目录与主机。另一条直接工具调用复核内容为 alpha-verified-v2 加换行；模型回复提供带 SSH 地址的文件引用。七次调用全部成功，具体顺序、文件内容和恢复后的回复保存在 .local/verification-workspace-vps.json。

此前 OpenCode 的工具包检查从目标未连接的状态开始，实际完成：

~~~text
list_machines
connect_machine(vps1)
vps1__machine_info
vps1__write
vps1__edit
vps1__read
vps1__grep
vps1__find
vps1__ls
vps1__bash
~~~

它创建 agent-proof.txt，将 native 替换为 remote，读取并搜索结果，随后执行命令确认目标。独立 MCP 客户端再次读取文件，确认内容为 agent used remote MCP tools 加换行。客户端权限仅开放 demo 的 MCP 工具。

## 范围与清理

当前验证覆盖单用户 Linux、云端直接 SSH 登录目标、Pi 原生工具、工作区上下文、常驻 SDK 会话与额外 HTTP MCP。终端复用 Pi 的主要界面组件，完整 Pi 命令集、文件补全、图片粘贴、远端 skills 与扩展、持久 PTY 和 NAT 反向接入仍在后续范围。新提示等待当前任务结束后提交；运行期间可接管、取消和安排工作区切换。实际 NAS 尚未连接。

隔离验证结束后关闭临时服务、worker、SSH agent 和 loopback sshd，删除远端测试目录、临时会话与模型配置。VPS 上的常驻部署、专用密钥、演示工作区和演示会话继续保留。临时验证的模型凭据通过 SSH stdin 进入进程环境；常驻服务从受权限保护的环境文件读取。完整 JSON 报告与客户端记录位于 Git 忽略的 .local 目录。

静态检查包括 Ruff 代码与格式检查、Node 语法、生成工具契约一致性、Git diff 检查，以及 README.md、CLOUD_SESSIONS.md、VALIDATION.md 的禁词校验。
