# 接入共享环境

把私有接入文件交给现有 Agent，让它读取网址上的协议，即可使用 VPS4 管理的机器、工作区、Pi 工具和额外 MCP 服务。Agent 使用自己的网络请求或终端工具完成接入，会话保留在原客户端。

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

部署脚本复用 VPS4 的 Caddy HTTPS 代理，新增独立站点；环境服务仅监听 `127.0.0.1:3180`。默认网址通过 VPS4 公网 IP 的 sslip.io 域名访问，Caddy 申请并续期受信任证书，也可用 `--url` 指定已解析到 VPS4 的独立 HTTPS 域名。

```bash
.venv/bin/python deploy_environment_access.py
```

默认生成 `.local/共享环境接入.md`，权限为 600，目录由 Git 忽略。再次部署沿用文件中的账户和密钥。脚本先确认生产会话空闲，保存源码、配置及会话备份，再启动入口；它核对现有会话、输入权、工作区分组、草稿和原配置，并通过公网 HTTPS 调用真实工具。部署异常时回滚源码、启动配置和 Caddy 路由，备份位置记录在 `.local/environment-access-deployment.json`。

VPS4 的私有配置为运行时下的 `dsh-state/environment-access.json`，仅保存账户与 `SHA256(account + NUL + key)` 摘要。设置 `enabled: false` 可停止后续访问；替换摘要可撤销旧密钥，HTTP 和已建立的 MCP 会话在下一次请求时重新检查凭据。调整网址或监听端口后重启 Host。已有安装与会话继续使用原来的入口。

隔离验证运行 `verify_environment_access.py`，使用真实 SSH、原生 Host、官方 MCP SDK 与 Pi 工具；部署后的证据与边界见 [验证记录](VALIDATION.md)。
