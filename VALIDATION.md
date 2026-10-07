# 验证记录

远端工作区会话已通过本机 SSH、HTTP 和 VPS 上的真实 Pi agent 验证。Pi 会话、模型调用与对话存储运行在 VPS 4，七个原生工具和项目上下文来自 VPS 1。验证时间为 2026-10-07。

## 环境与结果

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

当前验证覆盖单用户、Linux SSH 目标、Pi 工具包、工作区上下文资源与 SDK 会话。新验证中的 Pi agent 实际运行在 VPS 4；旧网关协议检查的客户端在本机运行。常驻服务、完整终端 UI、远端 skills 与扩展、持久 PTY 和其他 MCP 能力尚未接入。同一会话文件按单进程使用，多个新会话可以并行工作。

测试结束后关闭临时网关、worker 和 SSH agent，删除目标测试目录。新验证也清理临时 Pi 模型配置和会话，模型 API 凭据仅传入进程环境。VPS 4 保留网关、启动器、Node 依赖及独立 Python 环境。完整 JSON 报告与客户端记录位于 Git 忽略的 .local 目录，使用方法见 README.md。

静态检查通过：Ruff 代码与格式检查、Node 语法检查、生成契约一致性检查、Git diff 检查，以及 README.md、VALIDATION.md 的禁词校验。
