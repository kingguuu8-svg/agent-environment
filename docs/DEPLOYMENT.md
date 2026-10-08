# 部署

Host 运行代码与状态保存在不同目录。源码目录安装固定依赖；默认 `.local/platform` 保存账户、模型配置、目标登记、设备密钥和会话。前台模式适合首次验证，Linux 用户服务适合常驻。

## 常驻服务

完成初始化后生成服务文件，再安装到当前用户的 systemd 目录：

```bash
python3 agent_environment.py service
mkdir -p "$HOME/.config/systemd/user"
cp .local/platform/agent-environment.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now agent-environment.service
systemctl --user status agent-environment.service
```

DSH 的模型密钥可写入权限为 600 的 `.local/platform/model.env`。服务在启动时读取该文件。要在退出 SSH 后保持用户服务，服务器管理员可以为该用户启用 linger。日志通过 `journalctl --user -u agent-environment.service` 查看，启动器会遮盖 Web 登录 token。

使用自定义运行时目录时，所有 `agent_environment.py` 命令传入同一个 `--directory`。生成的服务文件已经包含该路径。

## HTTPS 入口

Environment 服务绑定 `127.0.0.1`。公网访问由 TLS 代理转发；域名需要解析到 Host。以 Caddy 为例，初始化时指定入口域名：

```bash
python3 agent_environment.py init --url https://env.example.com/ \
  --workspace /home/you/agent-workspace --targets targets.json
```

运行时中的 `Caddyfile` 包含该站点的 `reverse_proxy` 配置。将其加入服务器实际使用的 Caddy 配置，通过 `caddy validate` 后重载 Caddy，并允许 HTTPS 流量。该文件是配置片段，现有代理配置需要由部署者合并。

Agent 接入文件会使用该 HTTPS 域名。HTTP Basic 凭据放在请求头中；入口公开说明协议，资源发现和执行都需要认证。DSH Web 继续使用受限 SSH 转发，Web 与 Environment 使用不同的凭据。

## 设备安装器

`prepare-devices` 需要 Host 已有可从工作机访问的 SSH 服务。它从服务器自身的 Ed25519 主机公钥生成设备使用的 known_hosts，准备有校验的安装器资源，并在私有运行时生成 `keys/host-to-devices`。

```bash
python3 agent_environment.py prepare-devices \
  --ssh-host you@host.example.com --ssh-port 22
```

自定义主机公钥位置使用 `--host-key`；它应与设备实际连接的 SSH 服务一致。安装器签发和设备接入会维护 Host 用户的 `~/.ssh/authorized_keys`，每个设备使用独立、受限的连接密钥。包内的配对凭据 15 分钟后过期；新的配对包可以恢复已有设备的连接。

安装器资源会下载到源码目录的 `.local/device-installer-assets`。已有 fd 官方归档可通过 `--asset-dir /path/to/asset-cache` 复用，文件名和 SHA256 必须匹配固定版本；缓存不保存账户或设备密钥。网络不可用时资源准备会停止，恢复下载后重新运行同一命令即可。

新的 Web 端口会写入配对结果、设备配置和 SSH 的 `permitopen`，安装器沿用该端口。旧部署缺少这一字段时继续使用 3080。

## 更新和恢复

更新前停止服务，并备份整个运行时目录。DSH 的会话在 `dsh-home`，工作区、绑定、文字草稿和配对信息在 `dsh-state`；`connection.md`、`model.env`、设备密钥和目标配置也属于备份。备份包含敏感数据，应保存在私有位置。

更新同一路径下的源码后重新运行对应的 `scripts/setup.sh`，再执行 `doctor` 和启动服务。源码路径改变时，DSH profile 的模块链接和服务文件需要重新生成；当前版本建议保持部署路径。已初始化目录使用 `start`，`init` 会拒绝覆盖它。

`prepare-devices` 会刷新安装器使用的源码，并沿用现有设备密钥。更改公开 SSH 地址或端口会影响已安装设备，命令因此拒绝直接替换不同的设备平台配置。保留旧入口，完成设备重新接入后再移除它。

出现问题时恢复原源码与运行时备份。工作机上的实际文件和已经执行的命令结果保留原状，恢复 Host 历史之后应重新检查文件状态。

## 凭据维护

Environment 接入配置只保存 `SHA256(account + NUL + key)`，明文 key 留在私有接入文件中。替换账户或摘要会在下一次请求撤销旧凭据，包括已经建立的 MCP 会话。设置 `enabled: false` 可以停止后续访问。

更改服务 URL 或端口后需要重启，并同步接入文件与代理配置。每个连接文件当前代表整个个人环境，具有所有已登记资源的执行能力。
