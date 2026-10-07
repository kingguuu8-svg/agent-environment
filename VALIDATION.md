# 验证记录

## DSH Web 产品

2026 年 10 月 7 日，DSH Web Host 已部署在 VPS4，VPS1 与当前电脑均已接入。真实模型使用 `cpa/gpt-6-sol`，工具使用锁定的 Pi 1.0.2；DSH 使用 0.2.0-rc.2。下面的结果对应 `feature/dsh-remote-workspaces` 分支。

| 验证对象 | 入口与环境 | 结果 |
| --- | --- | --- |
| 会话、排队切换、输入权、文件作用域 | `verify_dsh.py`，Agent 在 VPS4，目标 VPS1，真实模型 | 16 项通过 |
| 取消、目标离线、进程丢失、Host 重启 | `verify_dsh_recovery.py`，VPS4 与当前电脑，真实模型与实际服务停启 | 7 项通过 |
| 新 HTTP MCP 的发现与调用 | `verify_dsh_mcp.py`，独立 DSH Host、真实模型、临时 HTTP MCP 服务 | 2 项通过 |
| 模型请求、环境选择、接力与连接状态 | `verify_dsh_context.py`，独立 Host、loopback SSH、实际 HTTP 录制端点 | 18 项通过 |
| 输入权持久恢复与分支独立 | `verify_dsh_ownership.py`，独立原生 Host、本地 SSE 模型、两次停启 | 7 项通过 |
| 客户端发送失败与返回结果 | `verify_dsh_client.mjs`，实际客户端拦截器、loopback HTTP 服务 | 4 项通过 |
| 多窗口草稿与会话选择恢复 | `verify_dsh_drafts.mjs`，原生 Store 引擎、实际工厂与插件、模拟浏览器存储 | 13 项通过 |
| 启动等待、取消与登录恢复 | `verify_dsh_launcher.py`，独立 Host、loopback SSH、真实 Linux 用户服务 | 16 项通过 |
| 既有 Pi MCP 工具行为 | `verify_local.py`，独立 loopback sshd | 23 项通过 |
| 既有远端工作区入口 | `verify_workspace_local.py`，两个并行目录与 HTTP MCP | 11 项通过 |

首轮工作环境改进运行了 12 项模型请求与环境检查、16 项 VPS4 真实模型检查。2026 年 10 月 8 日的接力改进将请求与环境检查扩展到 18 项，并重新运行了 7 项输入权恢复与分支检查、4 项客户端发送失败检查。表中其他脚本保留此前产品实现的验证记录。VPS4 页面此前检查全局新建和工作区加号；快速双击各自只增加一个原生会话，均绑定实际选择的桌面目录并打开可编辑输入框。

本轮实际 Web 操作检查统一环境入口、已有工作区选择、子目录筛选、未载入路径的确认限制、错误路径恢复、SSH 目标切换、路径复制及 Escape 焦点恢复。在 1280×720 的隔离页面中，确认区与实际路径始终可见。刷新同一窗口后输入仍可用，新窗口保持只读。目标目录暂时移走后显示异常；恢复目录后，环境面板通过连接检查自动重新加载原目录。VPS4 页面使用实际桌面目标核对机器、完整路径与云端记录提示。检查过程保留用户会话与原执行绑定。

会话验证检查执行中保持旧目标、撤回与重新安排切换、旧版本选择被拒绝，以及切换前已经排队的消息在新目标执行。重复提交同一请求编号后，目标文件只追加一行。非法目录保留旧绑定，原生文件预览拒绝工作区外路径。原生 fork 继承历史和绑定，输入权独立；接管后旧窗口的提交被拒绝，原生 prompt API 也无法绕过控制权。

恢复验证实际停止本机反向 SSH 服务，检查文件读取、目录选择和工作区切换均被拒绝，云端仍能读取自己的文件。目标恢复后，原文件侧栏通过同一绑定重新工作。另一个检查只终止 DSH 自己的云端文件 worker，后续请求重新连接，无需先运行模型。

HTTP MCP 验证使用随机工具名，提示词只描述需要的功能。模型通过 `environment` 首次发现实际工具契约，调用该工具后写入结果；服务端调用记录与工作区文件独立复核通过。显式调用额外服务后，会话的默认工作区保持原值。

模型请求检查直接读取 DSH 提供商发出的 HTTP 消息，核对同一会话从云端切到 SSH 工作区、更新项目指令、再切回云端时的有效系统提示词。每次请求包含当前机器、目录与绑定版本；旧项目指令被替换，模板括号保留原文，历史仍然存在。工作区准备检查默认命名、并发重复选择、旧临时名称修正，以及在已有工作区新建会话并保留手动命名。录制端点返回固定流式响应，模型语义与工具副作用由真实模型检查覆盖。

环境回归检查原生工作区身份与工具列表、并行真实目录探测、目标目录不可用时仍能访问云端，以及恢复后使用原目标读取文件。探测保持绑定版本、历史与输入控制者；未知目标被拒绝。超时检查只暂停隔离 SSH 目标的实际 MCP worker，确认等待在 12 秒后结束、另一云端目标仍可访问，恢复 worker 后同一目标重新可用。检查接口为已认证的 `remoteWorkspaces/probe`，共用同一目标的进行中探测；浏览器取消等待保留其他会话的连接。可用性结果在 65 秒后失效，页面可见时每 30 秒检查当前目标。

本次请求检查修复了先前未覆盖的缺陷：`includeRuntimeContext: false` 会过滤通过 `systemPrompt.context` 注册的工作区信息，且 `agent/pre-step` 刷新发生在提示词组装之后。插件现在使用独立的系统提示词段，并在组装阶段刷新目标事实。旧演示会话日志的抽检确认缺少该环境信息；工具路由原本独立生效，因此先前的工具副作用验证无法证明上下文已发送。

部署后的真实模型会话日志包含 3 次系统消息，均包含当前执行环境；记录覆盖 VPS4 云端工作区与 VPS1。运行文件与本地源码的 SHA256 一致，云端 DSH、Pi 以及本机设备连接服务均保持运行。

重启检查让远端命令先追加一次记录，再等待；保存待切换目标后重启 VPS4 Host。原生会话恢复到该目标，旧输入凭据失效，已追加记录仍为一行，命令后半段没有执行。插件事件携带 DSH 的 `ignorable` 外层字段，绑定与控制权操作使用原生 `sessions.flush` 作为持久化检查点。早期演示日志经过带原件备份的修复，已有跨机器对话恢复并保留完整内容。

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
.venv/bin/python verify_dsh_context.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
.venv/bin/python verify_dsh_ownership.py --node /home/kingguuu8/.local/node/bin/node
/home/kingguuu8/.local/node/bin/node verify_dsh_client.mjs
node verify_dsh_drafts.mjs
.venv/bin/python verify_dsh_launcher.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
```

恢复脚本会暂时停止设备连接和重启 Host，应在空闲时运行。私有启动信息与完整验证记录位于忽略目录中。该版本验证了个人 Linux 环境；其他操作系统、多人权限隔离、远端扩展与持久交互式终端尚未覆盖。安装和维护方式见 [云端 DSH](DSH_REMOTE.md)。

## Web 输入权恢复

2026 年 10 月 8 日，在隔离 Host 中复现了维护重启丢失控制窗口的问题：查看者先请求输入权后获得控制，原窗口随后变成只读。现版从原生会话日志恢复控制窗口，并为新进程生成新的输入凭据；分支日志中的继承事件保留为历史，输入权由分支自己的事件决定。

`verify_dsh_ownership.py` 的 7 项检查通过真实原生 API 验证首次控制、查看者只读、明确接管、分支绑定与输入权独立、两次进程停启、旧凭据与外来窗口被拒绝，以及正确控制者重命名后结果持久保存。测试通过本地 SSE 响应完成真实 Agent 对话流程；模型服务费用为零。旧版 Host 产生的版本 1 缓存也在独立环境中升级验证：先到达的查看者保持只读，原窗口获得新的凭据。

浏览器验证完成两轮模拟模型对话，确认两个新窗口身份不同、当前窗口刷新及插件更新保留身份；服务重启后原窗口继续可输入，查看者保持只读；明确接管后再次重启，新控制窗口可以直接发送。草稿在断线、发送失败、页面刷新和恢复后保留，重连期间没有自动提交。相关的 12 项模型上下文与连接回归、5 项实际工具桥和设备反馈回归全部通过。验证保留用户实际会话，临时 Host 与模型服务在结束后清理。

新版在云端所有会话空闲时备份并部署。13 个部署源码文件的 SHA256 与本地一致；已有两个控制者从日志恢复，随机查看者保持只读；三个原生工作区可读取，云端、当前电脑和 VPS1 的真实文件工具探测通过，机器列表保持原值。用户原页面完成重连，保留会话与工作区，并按已有控制记录显示输入权限。

## Web 连接反馈

2026 年 10 月 8 日，隔离浏览器复现了两个问题：停止云端 Host 后，页面把当前工作区标成连接异常，发送失败显示底层 fetch 错误；断线期间打开工作环境面板，恢复后仍停留在空机器列表和禁用路径框。

现版区分 RPC 业务结果与传输失败。业务失败保留其原因，传输失败显示云端断线；登录失效提供重新打开入口的说明。工作环境面板在重连后自动载入机器列表与原目录，首次读取失败也可以直接在面板内重试。目录加载请求在离开面板时取消。

`verify_dsh_client.mjs` 的 4 项检查加载实际客户端拦截器并请求 loopback HTTP 服务，断言业务拒绝保留原因、服务端收到一次输入后丢失响应时提示结果未确认且没有重放、HTTP 401 给出登录恢复操作，以及主动取消保持取消结果。脚本覆盖 RPC 返回行为；页面状态由实际浏览器另行验证。

浏览器验证实际移走隔离会话绑定的目录，确认显示工作区不可用，云端 API 与根工作区仍可用；恢复目录后，原面板自动载入同一目录。停止 Host 后，页面显示云端断线、保留草稿并提供重连入口；明确点击发送后显示结果未确认，草稿仍在。重启后原绑定保持、已完成轮次仍为 2，保留内容没有自动提交。断线时打开的工作环境面板恢复后自动重新读取目录；全局新建面板在恢复后点击重试可直接载入机器列表。过程只使用隔离 Host、本地模拟模型与临时目录，用户云端会话保持。

临时 Host、模拟模型、目录和浏览器窗口已清理。新版在会话空闲时备份并更新到 VPS4；13 个源码文件哈希一致。部署后检查已有输入控制关系、查看者只读、三个原生工作区的文件读取及三台机器的真实工具探测均通过，机器目录保持云端、当前电脑和 VPS1。

## Web 会话接力

2026 年 10 月 8 日，用两个隔离浏览器窗口复现了跨设备接力的操作障碍：B 打开 A 的会话，选好 B 的目录后切换按钮仍禁用，需要关闭面板、接管输入、重新选择目录。现版在同一面板提供接管并切换，选择目录后明确提交即可继续同一会话。

服务端通过 `switch` 请求的 `takeover: true` 明确执行接力，校验窗口身份、绑定版本与目标可用性。准备期间输入权保持原值，提交时再次校验控制窗口与绑定版本；新的输入权和绑定写入单条兼容标记为 `ignorable` 的 `remote/handoff` 事件。执行中的任务继续使用原绑定，下一轮才使用待切换目标。旧客户端的普通切换仍要求其输入凭据。

18 项请求与环境检查覆盖查看者的普通切换被拒绝，非法身份、未知机器、失效目录及过期选择保持原输入权和绑定；接力成功后旧窗口不能再提交，重复确认旧版本被拒绝。真实 Agent 循环停留在一次实际模型 HTTP 请求中时接力，当前请求仍包含原云端目标；新控制者重复排队同一请求，随后只执行一轮，实际 HTTP 系统消息及原生文件读取均使用新的 SSH 工作区。慢准备验证暂停隔离目标的真实 MCP worker，通过其 stdin 管道已有请求数据确认准备开始，再由第三窗口明确接管；恢复 worker 后，旧准备请求被拒绝，第三窗口及原执行位置保持。

7 项输入权检查重新通过，覆盖接力记录后的原生分支、两个进程冷启动和旧输入凭据拒绝。包含接力事件的分支继承对应工作区，输入权独立；接管与切换在重启后一起恢复。4 项客户端异常反馈检查也通过。

浏览器先使已经选择的 SSH 目录失效，提交接力后原控制者、输入凭据与绑定均保持，面板保留选择。目录恢复后，在同一面板再次提交完成接力，A 自动进入只读，B 成功完成第二轮对话，原历史保留；原生文件读取返回 B 的项目指令。压缩会话日志独立核对，仅有一条接力事件，同时记录控制者与目标并带有兼容标记。再次停启 Host 后，B 的输入权和 SSH 工作区同时恢复。

在会话空闲时备份并部署到 VPS4，13 个运行源码文件的 SHA256 与本地一致。逐个对比已有 35 个会话的标题、记录统计、工作区绑定、持久控制记录与预设，语义状态保持原值；26 个控制者恢复，三个原生工作区可读取，三台机器实际文件工具探测通过，机器清单保持。首次检查曾有一次输入权限断言失败，未记录对应会话；紧接着审计未发现差异，完整复查通过，尚未确认原因。

随后在 VPS4 上创建独立 Host，验证 36 个控制者从旧版投影缓存升级后恢复，先到达的查看者仍只读。该 Host 通过实际 VPS1 工具连接完成无效目录拒绝、接管并切换、原控制者拒绝、原生重命名与文件浏览、重复旧确认拒绝；再次冷启动后新控制者和 VPS1 绑定一起恢复。测试使用独立状态目录，结束后清理临时进程与文件，日常服务 PID 保持。

本轮证据位于忽略目录中的 `.local/verification-dsh-context.json`、`.local/verification-dsh-ownership.json`、`.local/verification-dsh-handoff-ui.json`、`.local/verification-dsh-handoff-deployed.json` 与 `.local/verification-dsh-handoff-live.json`。日常页面只读检查保留原会话与执行目标。

## Web 启动反馈

2026 年 10 月 8 日，用独立后台连接复现云端不可达时终端无反馈的问题：命令等待七秒仍运行，stdout 与 stderr 均为空。旧版最多等待五分钟。现版启动时显示进度，每 10 秒更新，默认后台入口约 45 秒后结束等待并提供诊断与重试方法；后台连接继续保持。

`verify_dsh_launcher.py` 的 16 项检查使用真实 loopback SSH、独立 DSH Host 和 Linux 用户服务。直接用户服务与原生 supervisor 两种入口均验证冷启动、重复使用时的 PID 与目录提示、10 秒等待反馈、Ctrl+C 退出码 130，以及取消后复用同一连接。暂停独立 Host 使真实 HTTP 请求无法完成，确认后台入口在 45 秒附近以退出码 1 结束，显示日志位置；恢复 Host 后同一 PID 可重新进入。两次实际 Host 重启后，入口自动更新登录信息。

实际前台连接复现了入口缓存冲突：使用相同配置启动前台时，后台缓存被替换，退出又将它删除。现版让持久服务维护共享缓存，普通前台入口只返回自己的登录链接。两种后台方式均验证前台期间与退出后缓存保持原值，原连接继续可用；分别移除缓存与写入不匹配的进程身份后，入口刷新一次服务并完成登录，会话仍为空。

前台取消后，独立 SSH 转发端口关闭，Host 仍运行；错误 SSH 密钥被实际服务拒绝，未产生登录入口；未知机器由云端入口返回原因，客户端正常退出。所有检查结束后，会话列表仍为空，模型调用为零，测试用户服务、缓存、进程与目录均已清理。结果保存在 `.local/verification-dsh-launcher.json`，原问题证据位于 `.local/verification-dsh-launcher-before.json`。该轮验证覆盖 Linux 的两种连接方式，macOS 与 Windows 原生后台任务仍未覆盖。

发布时备份并更新 VPS4 与 VPS1 的三份客户端模块，以及 VPS4 的设备安装包；运行源码哈希与本地一致，安装包包含同一启动器。VPS1 的旧部署补齐此前缺失的 `state-json.mjs` 依赖。全程保持 Host PID；35 个原会话的目录、标题、统计、绑定、控制记录与预设保持原值。

本机实际命令连续两次通过原后台 PID 登录，目录提示正确；VPS1 已安装命令通过真实 SSH 登录、指向原项目，Ctrl+C 以 130 退出并关闭自身转发端口，会话数量保持 35；VPS4 直接入口也完成登录与目录检查。记录位于 `.local/dsh-launcher-deployment.json`、`.local/verification-dsh-launcher-desktop.json`、`.local/verification-dsh-launcher-vps1.json` 与 `.local/verification-dsh-launcher-vps4.json`。源文件备份位于各 VPS 运行时的 `launcher-backups`，回滚时恢复同一份备份中的客户端文件即可，云端会话服务保持运行。

随后复核发现，增量发布辅助脚本读取原生投影时遗漏了 `projections.values` 层，原检查中的标题、统计、控制记录与预设因此为空值。辅助脚本已改为直接索引实际字段，并依据发布前保存的完整快照重新审计全部 35 个会话。五项实际投影逐个相同；补充结果位于 `.local/verification-dsh-launcher-projection-audit.json`。先前的空值比较不能作为这些字段的保留证据，会话保留结论依据本次重新审计。

## Web 终端目录接续

2026 年 10 月 8 日，隔离浏览器复现：从 B 的终端项目进入，新建面板使用正确目录；打开 A 的会话后在工作环境面板选 B，却使用设备登记的默认目录。实际移走终端目录后，主目录和上一级均不可用，也缺少直接回到已知默认目录的操作。

本轮只修改客户端目录面板。起始目录依次使用面板内已浏览目录、当前会话在该机器的目录、本次终端入口目录、设备默认目录。切换面板保留终端目录快捷入口；目录错误时，可明确打开不同的设备默认目录。浏览过程保持绑定与控制关系。

13 项浏览器观察覆盖入口预选、打开其他设备历史、机器切换、明确目录记忆、目录实际移走与恢复、接管并切换、历史保留、当前会话目录优先，以及没有入口提示时的默认行为。在真实 loopback SSH 与独立原生 Host 中，B 接力后的第二次模型 HTTP 请求包含终端目录和 `TERMINAL-B-MARKER`，当前系统上下文排除 A 与登记默认目录的项目指令，上一轮 `A-HISTORY-MARKER` 仍在历史。原生文件读取返回同一终端项目指令；原控制者为只读。明确切到 B 的另一目录后，重开面板及 A→B 浏览仍保留该目录；点终端快捷入口并取消，后端绑定保持。

模拟模型共收到两次请求。隔离 Host、模型、SSH、代理端口、临时目录和浏览器页已清理，用户页面保持。证据位于 `.local/verification-dsh-entry-path-before.json`、`.local/verification-dsh-entry-path-ui.json` 与 `.local/verification-dsh-entry-path-model.json`。客户端 4 项 HTTP 异常回归、JavaScript 语法、Python lint 与格式检查通过。该轮在 Linux 浏览器与 SSH 环境中验证；macOS 和 Windows 原生入口仍待真机检查。

会话空闲且没有待切换目标时，VPS4 备份并仅替换 `dsh-product/plugin/client.js`，重启 Host 后刷新本机入口。运行文件哈希与已验证源码一致；35 个会话的五项实际投影及当前绑定、7 个原生工作区分组、机器目录与六份配置文件保持原值。26 个已有控制者恢复，随机查看者仍只读；云端、当前电脑和 VPS1 的原生文件浏览与实际工具探测通过。原页面刷新后保留会话、执行位置与查看权限，当前目标已连接。部署证据位于 `.local/verification-dsh-entry-path-deployed.json`，原界面备份留在 VPS4 的 `dsh-state/backups/terminal-entry-*` 中；回滚时恢复同一备份的 `client.js` 并重启 Host。

## Web 多窗口恢复

2026 年 10 月 8 日，两个隔离窗口复现同一会话草稿被覆盖：A 留下未发送内容，B 接管后改写，A 刷新随即显示 B 的内容。进一步切换项目时，B 打开其他会话也会使 A 刷新跳到该会话。两种行为均来自浏览器中共享的保存位置。

本轮保留窗口自己的草稿和会话选择，用于刷新恢复。新窗口继续恢复浏览器最近的会话与草稿；当前控制窗口更新供新窗口恢复的草稿，查看者切换视图或迟到的发送失败恢复保留其窗口内容。文字草稿通过有版本检查的原生 Conversation 工厂接入，会话选择通过当前插件订阅原生导航 Store。云端记录、控制权和工作区协议保持。

13 项自动检查执行实际补丁后的 Conversation 工厂与原生 Store 引擎，并加载实际客户端插件。结果覆盖旧草稿恢复、查看者视图变化、接管后独立恢复、发送与空草稿、丢失输入权后的迟到恢复、不同项目、存储失败与损坏、普通 DSH 的原生保存，以及窗口会话选择、无效缓存与新窗口默认恢复。测试依赖固定为上游使用的 Zustand 4.4.7 与 Immer 10.1.1，仅用于开发验证。安装 `dsh-product` 的开发依赖并运行补丁后，可执行 `node verify_dsh_drafts.mjs`。

11 项实际浏览器与集成检查使用独立原生 Host、loopback SSH 与本地 SSE 模型，确认 A 与 B 的独立草稿、查看者切换轨迹后新窗口仍恢复 B 草稿、B 发送后自己的刷新为空而 A 内容保留、不同项目切回与刷新、各自会话选择和维护重启后的输入权限。新查看窗口保持只读，新建面板仍使用终端目录。模型共收到三次请求，其中两次为初始验证历史，之后只收到明确发送的 B 内容；A 与另一项目的未发送内容均未提交。重启前后的两份原生会话投影与绑定相同。

客户端 HTTP 异常回归 4 项、重复应用补丁的幂等检查、依赖锁一致性、JavaScript 语法、Python lint 与格式检查通过。临时 Host、模型、SSH、代理端口、目录和浏览器页已清理。证据位于 `.local/verification-dsh-drafts-before.json`、`.local/verification-dsh-drafts-store.json` 和 `.local/verification-dsh-drafts-ui.json`。该轮验证 Linux 浏览器环境；macOS、Windows 真机与关闭窗口后的浏览器恢复行为仍待覆盖。

新版已部署到 VPS4。部署前确认会话空闲且没有待切换目标，备份五份产品源码与包文件、三份生成后的原生 JavaScript，再应用补丁并重启 Host。运行源码及三份生成文件均与本地验证版本哈希一致，重复应用补丁保持幂等。35 个已有会话的五项投影及当前绑定、7 个工作区分组、机器目录与六份配置逐项保持；26 个原控制者恢复，随机查看者保持只读。云端、当前电脑与 VPS1 的实际原生文件浏览和工具探测通过。原产品页面只读刷新后保留会话标题、执行位置与查看权限，目标已连接，未引入草稿；生产验证没有发送消息或接管输入。部署证据位于 `.local/verification-dsh-window-deployed.json`，备份位于 VPS4 的 `dsh-state/backups/window-recovery-*`。回滚须按备份中的 `manifest.json` 同时恢复产品源码与生成后的原生文件，再重启 Host。

## 设备安装

2026 年 10 月 7 日，Web 已提供 Linux、macOS 和 Windows 安装包选择。设备通过出站 SSH 连接到 VPS4，本机使用 Python 工具桥接进程运行原生 Pi 工具。Linux 安装在 VPS1 的全新普通用户上验证；macOS 与 Windows 为预览版，尚未完成对应系统的真机安装验证。

| 验证对象 | 入口与环境 | 结果 |
| --- | --- | --- |
| 三种安装包、配对与失败恢复 | `verify_device_onboarding.py`，真实文件、公钥、并发登记与 loopback HTTP 下载 | 14 项通过 |
| 工具桥接、目录与取消 | `verify_device_bridge.py`，真实 Pi 工具与两个并行工作区 | 7 项通过 |
| 下载、安装、重复运行、Web 登录与后台服务恢复 | `verify_device_vps.py`，VPS4 与 VPS1 的隔离普通用户 | 6 项通过 |

配对验证覆盖临时凭据过期、同一安装包只能登记一台设备、SSH 强制命令与转发范围、并发端口分配、登记响应丢失和使用新安装包恢复同一设备。三种包均携带对应系统 x64 与 arm64 的官方 fd 归档，核对固定 SHA256；Linux 与 macOS 脚本通过 Bash 语法检查，Windows ZIP 中的 Python 解码代码在 Linux 上实际提取全部文件并逐项比较。Windows 模板还通过微软 PowerShell 解析器检查；这些结果覆盖脚本与打包行为，原生系统安装仍需真机验证。

下载验证使用真实 HTTP 端点中断传输，确认重新获取完整文件、连续失败三次后结束以及拒绝超出大小上限的响应。目标机访问 GitHub 曾连续超时，因此部署时准备 fd 归档并随安装包分发；首次安装提前准备 ripgrep，七个 Pi 工具可在安装完成后直接使用。

桥接验证拒绝错误令牌，并在认证后延迟 10.2 秒传输工具包，确认较慢传输不会触发认证阶段的期限。验证还覆盖工作区上下文、实际文件浏览、全部七个工具、并行工作区、取消命令及取消后的继续调用。

VPS 验证从已认证 Web 获取独立安装包，在仅有系统 PATH 的全新用户中运行。重复安装保持设备身份、端口与两个后台进程的 PID；无需重启 Host 即可在目录选择器发现设备。云端运行全部七个工具，并从目标机独立读取文件确认副作用。已安装的 `dsh` 入口完成原生 Web 登录；删除临时解压目录后重启工具桥接与 SSH 连接，认证握手恢复，七个工具再次成功执行。测试结束后移除临时账号、云端登记、工作区与配对凭据。

本轮同时通过既有 SSH 工具的 23 项回归和模型上下文的 12 项回归。Web 检查三种系统选择、匹配的运行说明、预览提示、有效期与再次下载状态，以及 Escape 关闭；实际 Linux 安装包通过 API 保存并执行。内置浏览器的文件保存事件未取得验证证据。

复现设备检查：

```bash
.venv/bin/python verify_device_onboarding.py
.venv/bin/python verify_device_bridge.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
dsh web --remote --no-open
.venv/bin/python verify_device_vps.py --url-file /home/kingguuu8/.cache/remote-dsh/a36ca3ce857334ca.json
```

VPS 检查应在云端会话空闲时运行，清理临时登记会重启 Host。验证报告位于忽略目录中的 `.local/verification-device-onboarding.json`、`.local/verification-device-bridge.json` 与 `.local/verification-device-vps.json`；部署文件的 SHA256 和回滚位置记录在 `.local/dsh-device-platform-deployment.json`。

### 接入进度

2026 年 10 月 8 日，接入页补充真实连接反馈与返回目录选择的行为。配对状态由云端记录提供，连接可用性由原生工作区文件工具检查；并行页面共享准备过程。轮询只在页面可见时运行，完成或关闭后结束。

| 验证对象 | 入口与环境 | 结果 |
| --- | --- | --- |
| 等待、部分注册、完成、过期与非法输入 | `verify_device_onboarding.py`，真实配对文件和 CLI | 16 项通过 |
| 鉴权、并行检查、离线与恢复、状态和会话边界 | `verify_device_feedback.py`，隔离 DSH Host 与真实工具桥 | 4 项通过 |
| 独立安装包与连接反馈 | `verify_device_vps.py`，VPS4 与 VPS1 全新普通用户 | 7 项通过 |
| 工作区与实际模型系统提示词 | `verify_dsh_context.py`，真实 SSH 与 HTTP 请求记录 | 12 项通过 |

浏览器验证确认：进入接入页并返回，原机器、未提交路径和筛选保持；重复点击已选择的 Linux 保留安装包；真实配对后从工具准备变为已连接，点击入口返回新设备的目录选择，仍等待用户确认。切换机器时显示新目标路径。页面验证使用隔离配置和真实本机工具桥；实际 Linux 包通过 Web API 保存并在 VPS1 执行。浏览器保存文件事件、macOS 与 Windows 的原生安装仍未覆盖。

复现进度检查：

```bash
.venv/bin/python verify_device_feedback.py --node /home/kingguuu8/.local/node/bin/node --npm /home/kingguuu8/.local/share/remote-dsh-device/npm
```

报告位于 `.local/verification-device-feedback.json`。

### 重复接入

2026 年 10 月 8 日补充已有设备使用新安装包的确认过程。云端固定入口提供机器身份，确认只消费当前安装包记录；设备配置、已有 SSH 权限与会话绑定保持。反馈失败时，入口继续提供原有 Web 访问能力。

`verify_device_onboarding.py` 的 19 项检查覆盖并行重复确认、拒绝不同机器、拒绝过期或系统不匹配的安装包，以及登记和权限文件逐字节保持。`verify_device_feedback.py` 的 5 项检查通过真实 Host 和工具桥验证固定入口：请求中伪造的机器编号被忽略，新包状态关联到入口所属的原设备；进度确认失败仍返回有效 Web 入口。匿名请求及非法输入被拒绝，会话与工作区分组保持。

`verify_device_vps.py` 的 8 项检查通过：在 VPS1 的全新普通用户中首次安装、重跑同一包，再运行新生成的安装包。新记录从等待变为原设备已连接；设备身份、端口、后台进程 PID 保持，七个 Pi 工具与 Web 入口继续可用。重启后台任务后再次验证全部工具。临时用户、两份配对记录、云端登记和工作区已清理，部署源码哈希一致。使用前述命令复现；macOS 与 Windows 原生安装仍未覆盖。

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

前述 Pi 终端验证覆盖单用户 Linux、云端直接 SSH 登录目标、Pi 原生工具、工作区上下文、常驻 SDK 会话与额外 HTTP MCP。终端复用 Pi 的主要界面组件，完整 Pi 命令集、文件补全、图片粘贴、远端 skills 与扩展及持久 PTY 仍在后续范围。新设备的反向接入由 DSH 工具桥接连接提供。新提示等待当前任务结束后提交；运行期间可接管、取消和安排工作区切换。实际 NAS 尚未连接。

隔离验证结束后关闭临时服务、worker、SSH agent 和 loopback sshd，删除远端测试目录、临时会话与模型配置。VPS 上的常驻部署、专用密钥、演示工作区和演示会话继续保留。临时验证的模型凭据通过 SSH stdin 进入进程环境；常驻服务从受权限保护的环境文件读取。完整 JSON 报告与客户端记录位于 Git 忽略的 .local 目录。

静态检查包括 Ruff 代码与格式检查、Node 语法、生成工具契约一致性、Git diff 检查，以及 README.md、CLOUD_SESSIONS.md、VALIDATION.md 的禁词校验。
