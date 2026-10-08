# 接入共享环境

把私有接入文件交给现有 Agent，让它读取网址上的协议，即可使用 Host 管理的机器、工作区、Pi 工具和额外 MCP 服务。Agent 使用自己的网络请求或终端工具完成接入，会话保留在原客户端。

接入文件包含 `url`、`account`、`key` 三个字段。入口公开提供接入协议；资源发现和执行使用 HTTP Basic 认证，账户对应用户名，密钥对应密码。凭据只通过 HTTPS 请求头发送。该版本沿用现有个人环境的权限，能够操作全部已登记资源，工具使用目标登录用户的系统权限。

Agent 先 GET 入口网址，再向协议中的 HTTP 地址 POST JSON。协议提供完整输入结构和示例：

| action | 用途 | 参数 |
| --- | --- | --- |
| `list` | 查询机器、工作区和工具名称 | `action` |
| `context` | 取得工具结构，确认身份、实际目录、Git 与项目指令 | `target` |
| `workspace` | 登记某台机器上的已有目录，取得稳定编号 | `machine`、`workspace` |
| `call` | 在明确指定的工作区执行工具 | `target`、`tool`、`args` |

目标编号由环境返回，每次操作显式指定。相对路径从目标工作区起算；工作区是工具的当前目录，文件访问权限由操作系统决定。`context` 实时读取项目说明并检查实际目录；模型需要将返回的项目指令用于对应工作区。`list` 中的连接状态描述传输连接，使用前通过 `context` 确认目录可用。

同一个入口还提供标准 Streamable HTTP MCP，通过初始化返回使用说明，并暴露一个 `environment` 工具。HTTP 与 MCP 共用当前 Host 持有的 `Environment`、工作区登记与工具连接，外部接入保持 DSH 会话的工作区、草稿和输入权。

工具结果保留 Pi 的文本、图片、编辑差异，以及额外 MCP 的结构化数据。HTTP 请求断开与 MCP 取消只作用于对应调用。失败调用保留已经发生的文件影响；返回 `may_have_executed` 或失去回复时，先核对目标状态再决定是否重试。原生工具沿用自身时限，环境调用最多等待 180 秒，客户端建议使用至少 200 秒的超时。

## 部署与凭据

Environment 可以独立运行，也可以共用 DSH Host 已有的环境。通用安装和双机器任务见[快速开始](docs/QUICKSTART.md)。独立模式运行 `agent_environment.py init` 后生成私有 `connection.md`；DSH 模式使用同一入口，保持云端会话的工作区、草稿和输入权。

服务仅监听 loopback。SSH 转发用于本地接入，公网入口可使用 Caddy 等 HTTPS 代理。初始化时指定 `--url https://env.example.com/`，运行时会生成相应的代理配置片段。

私有 `environment-access.json` 只保存账户与 `SHA256(account + NUL + key)` 摘要。设置 `enabled: false` 可停止后续访问；替换摘要会在下一次请求撤销旧密钥，包括已有 MCP 会话。URL 或端口改变后需要重启服务并同步接入文件。

现有个人部署的 `deploy_environment_access.py` 仍保留，用于按 `vps-check` 配置更新旧 Host。新安装使用通用入口。隔离验证和权限范围见[验证方法](docs/VERIFICATION.md)。
