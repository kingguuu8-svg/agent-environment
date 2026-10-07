# 云端 DSH

在任意已接入设备的项目目录运行 `dsh web --remote`，即可打开 VPS4 上的 DSH。Agent、上下文和会话记录保存在 VPS4；七个 Pi 工具在会话当前选定的机器与目录执行。当前已接入 VPS4、VPS1 和这台电脑。

## 开始使用

在本机终端执行：

```bash
cd /你的项目目录
dsh web --remote
```

页面会打开“新建会话”，默认选中当前电脑与终端目录。点击“在此新建会话”后，按普通 DSH 的方式聊天、查看文件或继续工作。关闭终端后，本机后台连接继续保持；再次执行命令会复用同一连接，并使用新的终端目录。

工作区默认显示为“主机名 · 目录文件夹名”，例如 `fedora · lookforwork`。点击侧栏某个工作区旁的加号，会直接在该工作区新建会话。顶部“新建会话”和“添加工作区”提供同一套机器与目录选择；已有工作区可直接选择，子目录可以筛选。创建中显示进度；创建完成后的连接失败可重试，继续使用原会话。

目录输入框支持按 Enter 前往。修改路径后，需要先载入目录，确认按钮才会启用。面板底部始终显示实际选择的机器、完整路径和确认按钮；复制路径、Escape 关闭及焦点恢复都可直接使用。

当前本机地址为 `http://127.0.0.1:3081/`。首次访问通过启动命令完成登录。命令打印的登录链接具有访问整个个人云端环境的能力，适合留在自己的终端中。

在 VPS1 的 `/root/remote-pi-demo` 也已安装入口。没有图形桌面或用户服务管理器时，可使用前台连接：

```bash
cd /root/remote-pi-demo
dsh web --remote --foreground --no-open
```

前台连接持续占用终端，退出时关闭 Web 转发。普通 `dsh` 命令继续使用本机已有的 DSH 安装。

## 会话接力

打开已有会话时，执行机器与目录沿用该会话的记录。从另一台电脑访问页面不会自动改变它们。点击会话顶部带连接状态的工作环境入口，选择机器和已有目录，再点击“切换到此工作区”，即可继续同一份对话。新会话和已有会话都使用这个入口。

空闲时立即切换并显示成功提示；任务执行中显示待切换目标，当前任务完成或取消后才生效。已经排队的下一条消息使用新的工作区。“撤回”可取消待切换选择。模型每轮获得当前机器、目录、Git 状态与项目指令；文件侧栏也跟随同一绑定，并关闭上一工作区的预览。

当前执行目标由插件写入独立的系统提示词段，并在组装模型请求时先刷新 Git 与项目指令。预设继续关闭 DSH 的本机运行时快照；目标信息通过系统提示词发送。项目指令中的 `{{…}}` 保留原文。

同一会话可以在多个窗口查看，每次只有一个窗口能提交输入。刷新当前页面会保留本窗口身份；新窗口的输入框变为只读，点击“接管输入”可接力操作。需要独立继续一条思路时，使用 DSH 的“在新对话中分支”：新会话继承历史与工作区，输入权独立。

工作环境入口在打开会话时检查实际目标目录，页面可见时每 30 秒复查；切回页面也会重新检查。检查上限为 12 秒，结果只反映目标可访问性。出现异常时，可以点击“重试连接”，或在面板中查看原因并选另一台机器。连接恢复后，正在查看的当前目录会自动重新载入。

设备离线后，会话记录仍保存在云端，目标工具返回连接错误。切换操作先实时检查目标，失败时保留原绑定。设备恢复后可以重新读取文件或继续任务；失去结果的工具调用由用户和 Agent 检查实际文件后决定下一步。

## 共享机器环境

默认的 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 都来自 `@earendil-works/pi-coding-agent@1.0.2`。MCP 负责传输工具调用与取消，目标进程负责执行。工作区决定相对路径的起点，工具使用目标登录用户的系统权限。界面中的“目标用户权限”说明这一点；VPS1 目前使用 root。

Agent 还有一个 `environment` 工具，可以列出已经登记的工作区与 MCP 服务，或明确调用其中一个目标的工具。例如可以让它在本机项目工作时，同时检查云端服务。显式跨目标调用保持会话的默认工作区。

额外 HTTP MCP 服务可写入 VPS4 的 `dsh-targets.json` 中的 `mcp` 字段，重启 Host 后生效；格式与已有 `environment.mjs` 一致。新机器登记后，目录选择器重新读取配置，无需重启 Host。

## 接入一台 Linux 电脑

当前安装面向个人 Linux 环境，依赖 Node.js 22.19+、Python 3.11+、OpenSSH 客户端与 sshd、systemd 用户服务。首次工具安装需要访问 npm；Pi 搜索工具缺少依赖时还会访问 GitHub。

在新电脑准备项目依赖及已有 VPS4 SSH 登录配置后，执行：

```bash
uv sync --python 3.12
npm ci
uv run python setup-dsh-device.py --config .local/vps-check.json --machine laptop
dsh web --remote
```

安装器在当前用户目录创建专用密钥、仅监听 loopback 的 SSH 工具端点和到 VPS4 的反向连接，并登记机器与安装入口。整个配置使用用户服务，保持已有系统 SSH 服务与防火墙配置。每个设备使用不同的机器编号与云端反向端口，例如第二台电脑使用 `--machine laptop --label 笔记本 --cloud-port 42023`。入口目录默认是 `~/.local/bin`，应已加入 PATH。

一个设备运行时固定对应一个机器编号和端口组合，重复安装沿用原身份。当前电脑的编号为 `desktop`，本地 SSH 端口为 22222，VPS4 的反向端口为 42022；入口安装在已有的 pnpm 命令目录。

## VPS4 部署

SSH 配置沿用 `vps-check.example.json`：`gateway` 对应 VPS4，`target` 对应 VPS1。两台主机的密钥已登记在部署机的 known_hosts 中，VPS4 具备 systemd 用户服务和 Python venv。部署脚本读取部署机已有 OpenCode 的 OpenAI-compatible 提供商与 API 认证配置。

```bash
uv run python deploy_dsh_vps.py --config .local/vps-check.json --model cpa/gpt-6-sol
```

它安装独立的 DSH Web 依赖、工具运行时、受限 SSH Web 入口及 `remote-dsh.service`。已有目标配置与会话数据保留。当前运行位置：

| 内容 | 位置 |
| --- | --- |
| VPS4 运行时 | `/home/ubuntu/.local/share/remote-mcp-demo` |
| DSH 配置与原生会话 | 运行时下的 `dsh-home` |
| 工作区绑定、环境清单、私有启动信息 | 运行时下的 `dsh-state` |
| 默认云端项目目录 | 运行时下的 `cloud-workspace` |
| 机器配置与模型配置 | `dsh-targets.json`、`dsh-models.json` |
| 模型凭据 | `dsh-model.env`，权限 600 |

VPS4 Web 只监听 loopback 的 3080，通过 SSH 转发访问。设备入口密钥限制为固定机器身份的启动命令及必要端口转发。工具端点只接受 VPS4 的专用公钥。该版本服务于同一位用户；共享 Web 登录具备整个个人环境的操作权限。

## 维护与恢复

在 VPS4 查看或重启 Host：

```bash
systemctl --user status remote-dsh.service
journalctl --user -u remote-dsh.service -n 50
systemctl --user restart remote-dsh.service
```

重启后重新运行本机 `dsh web --remote` 获取最新登录入口。已保存的会话与工作区恢复，旧输入权失效，窗口重新获得输入权。中断的工具调用保留其已发生的文件影响，后续请求检查实际状态。

本机的工具连接可以分别检查或重启：

```bash
systemctl --user status remote-dsh-device-sshd.service remote-dsh-device-link.service
systemctl --user restart remote-dsh-device-link.service
systemctl --user list-units 'remote-dsh-web-*'
```

暂停云端产品可在 VPS4 执行 `systemctl --user disable --now remote-dsh.service`；配置与会话继续保留。停止本机接入可执行 `systemctl --user disable --now remote-dsh-device-link.service remote-dsh-device-sshd.service`，再停止列表中的 Web 转发服务。若恢复此前的本机 DSH 入口，安装器保存的命令位于入口目录的 `.dsh-before-remote`。

升级前备份 `dsh-home`、`dsh-state` 和私有配置。回滚使用同一备份对应的源码与锁定依赖，重新生成 profile 后重启 Host。原有 Pi 云端服务使用独立会话目录，可继续通过 `pi --remote` 访问。

## 当前版本

Web 基于 DSH `0.2.0-rc.2`，通过插件复用其会话、聊天、分支、压缩与文件预览。安装后运行 `node dsh-product/patch-dsh.mjs` 应用三处有版本检查的兼容修改，使原生文件侧栏跟随工作区、输入框跟随控制权，并让插件事件携带 DSH 要求的兼容标记。升级 DSH 需要重新检查这些接口。

部署脚本会在停止 Host 后修复早期演示记录中缺少标记的插件事件，原日志备份留在同一目录的 `.before-remote-events-*` 文件中。修复只增加事件外层的兼容字段，保留消息、绑定数据、顺序和时间。

文件侧栏是只读预览，限定在所选目录中；单次二进制读取与文本扫描上限为 8 MiB，目录显示最多 2,000 项，变更按约两秒检查。Agent 修改文件使用 Pi 工具。原生本机终端、编辑器跳转、Git 变更卡片暂未接入远端工作区，因此该 profile 隐藏这些入口。远端 Pi 的扩展与 skills 尚未移植。

可重复验证见 [验证记录](VALIDATION.md)。`verify_dsh.py` 检查真实模型、排队切换、重复请求、输入权和文件作用域；`verify_dsh_recovery.py` 会暂时停止本机反向连接并重启 VPS4 Host，应在空闲时执行。`verify_dsh_mcp.py` 使用独立 Host 与随机工具名验证新 HTTP MCP 的首次发现和调用。

`verify_dsh_context.py` 在独立 Host 与 SSH 环境中抓取实际模型 HTTP 请求，检查切换前后目标、项目指令、历史保留及工作区命名。Host 启动时修正旧的自动生成名称；用户手动命名继续保留。
