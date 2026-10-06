# 验证记录

这个原型已验证常驻 MCP 入口通过 SSH 自动准备远端工具包，保持原生工具的接口契约，并由真实 agent 完成远端文件与命令操作。验证时间为 2026-10-07，结果对应当前原型代码。

## 环境与结果

| 环境 | 验证入口 | 结果 |
| --- | --- | --- |
| 本机 Fedora，Python 3.12.14，独立 loopback sshd | uv run python verify_local.py | 12 项通过 |
| VPS 4 Ubuntu，Python 3.12；VPS 1 Alibaba Cloud Linux，Python 3.11.13 | uv run python verify_vps.py --config .local/vps-check.json --agent-model cpa/gpt-6-sol | 12 项通过，OpenCode 客户端验证通过 |
| OpenCode 1.18.29，已有 cpa 模型配置 | 后端初始未连接，MCP 文件与命令工具授权 | 7 次实际工具调用完成，目标文件内容独立复核通过 |

本机测试使用全新目标目录和临时 SSH 密钥。两台 VPS 测试把网关运行在 VPS 4，以 VPS 1 作为工具目标，初次部署记录为 reused=false。SSH 主机密钥沿用本机已有记录；VPS 4 通过专用临时 SSH agent 获得目标登录能力，私钥文件保留在本机。

## 功能验证

自动化验证断言了目标上的真实文件内容和命令结果，包括连接前的接口声明与执行拒绝、未知目标、SSH 认证拒绝、接口契约一致性、重复连接、文件编辑、路径与符号链接越界、命令超时、工具进程退出、重连保留文件、并发连接及主动断开。

OpenCode 完成的调用顺序为：

~~~text
list_machines
connect_machine(vps1)
vps1__machine_info
vps1__write_file
vps1__edit_file
vps1__read_file
vps1__run_command
~~~

它在目标上创建 agent-proof.txt，把 native 替换为 remote，并读取结果。独立 MCP 客户端确认文件内容为 agent used remote MCP tools 加换行。命令执行位置和主机名对应 VPS 1。

机器配置、临时日志和完整验证 JSON 位于 Git 忽略的 .local 目录。复现命令和配置样例见 README.md。

## 设计判断

首版按连接状态增减工具列表，SDK 协议客户端能够接收变化通知并调用新工具。OpenCode 的实际任务只完成了管理与连接调用，随后明确报告新增工具没有进入可调用列表。

现版从预选工具包的同一份 SDK 定义提前公布工具契约，连接后再使用远端真实定义执行。两边 schema 的一致性由集成验证检查。修改后，OpenCode 在同一任务里完成了所有远端操作。这支持将接口声明与连接状态分开管理。

首次部署还确认了目标环境对启动的影响：VPS 1 默认 Python 3.6，另有 Python 3.11；其既有 pip 镜像连接超时。原型显式选择 Python 3.11 和实测可达的包索引，保持原有系统配置。

## 范围

验证覆盖单用户、预选 Python 工具包和 Linux SSH 目标。Agent 客户端在本机运行，网关在 VPS 4；统一 agent 运行时的常驻部署还需要选定客户端并配置它的状态目录。

当前验证集中于 tools。浏览器与 GUI 的用户会话、resources、prompts、远端发起的 sampling 与 elicitation、多用户访问和任意工具包的发现属于后续适配范围。

测试会关闭临时网关进程与 SSH agent，删除目标临时工作目录。VPS 4 留有网关程序和独立 Python 环境，便于再次启动验证。
