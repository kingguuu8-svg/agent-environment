# 快速开始

先把一台机器作为常驻 Host，再接入一台工作机。Environment 模式适合已有 Agent；DSH 模式提供中心化的 Web 会话。下面两种初始化方式选择其一，运行时目录默认为源码下的 `.local/platform`。

## 准备两台机器

Host 需要 Linux、Node.js 22.19.0+、Python 3.11+、uv 和 OpenSSH 客户端。SSH 工作机需要 Node.js 22.19.0+、npm、Python 3.11+，以及可从 Host 使用密钥登录的 SSH 服务。

在 Host 获取源码，后续安装和初始化命令都在这个目录运行：

```bash
git clone https://github.com/kingguuu8-svg/agent-environment.git
cd agent-environment
```

先在 Host 验证登录：

```bash
ssh devbox 'node --version && python3 --version'
```

首次登录时核对主机指纹。随后确认 `ssh -o BatchMode=yes devbox true` 成功。网关复用 OpenSSH 配置、已登记的主机密钥和 SSH agent。

复制 `targets.example.json` 为 `targets.json`，将 `host` 改为 Host 能使用的 SSH 别名或 `user@hostname`，将 `workspace` 改为工作机上已有的绝对目录：

```json
{
  "targets": {
    "devbox": {
      "host": "devbox",
      "label": "工作电脑",
      "workspace": "/home/you/projects/demo",
      "python": "python3",
      "node": "node",
      "npm": "npm"
    }
  }
}
```

SSH 密钥文件可通过 `identity_file` 指定。配置里的相对文件路径以原配置所在目录为基准，初始化会将它们转换为绝对路径。目标上的程序也可以使用绝对路径。工作机首次接入会在用户目录自动部署固定版本的 Pi 工具，安装需要访问 npm，搜索工具缺少时需要访问 GitHub。

## 使用现有 Agent

在 Host 的源码目录运行：

```bash
sh scripts/setup.sh environment
mkdir -p "$HOME/agent-workspace"
python3 agent_environment.py init \
  --workspace "$HOME/agent-workspace" --targets targets.json --label "中心主机"
python3 agent_environment.py doctor
python3 agent_environment.py start
```

保持服务运行，从使用 Agent 的电脑建立转发：

```bash
ssh -N -L 3180:127.0.0.1:3180 you@host
```

安全地复制 Host 上的 `.local/platform/connection.md` 到该电脑。默认网址是 `http://127.0.0.1:3180/`，通过上述转发访问。给 Agent 这个文件，并提出一个跨设备任务：

> 接入文件里的环境。读取 devbox 的项目上下文，在它的项目目录写入 cross-device-demo.txt，内容为跨设备连接成功。运行命令核对内容，然后把核对结果保存到 cloud 工作区的 verification.txt。

Agent 应先读取入口协议，认证后调用 `list`，通过 `workspace` 登记 `devbox` 的目录，读取 `context`，再分别调用目标的原生工具。它在 devbox 和 cloud 得到不同的目标编号；本机工具仍在 Agent 所在机器上运行。

可以在两台机器分别查看文件，确认实际效果。MCP 客户端使用入口协议返回的 `/mcp` 地址与同一组 HTTP Basic 凭据。公网 HTTPS 部署见[部署说明](DEPLOYMENT.md)。

## 使用 DSH Web

在全新运行时目录中安装 DSH：

```bash
sh scripts/setup.sh dsh
cp models.example.json .local/models.json
```

编辑 `.local/models.json` 中的模型地址、协议和模型编号。示例使用兼容 OpenAI Chat Completions 的服务；兼容 Responses 的服务使用 `api: "openai-responses"`。供应商的输入模态、上下文长度和推理选项按实际能力配置。

```bash
mkdir -p "$HOME/agent-workspace"
python3 agent_environment.py init --mode dsh \
  --workspace "$HOME/agent-workspace" --targets targets.json --model .local/models.json
cp .local/platform/model.env.example .local/platform/model.env
chmod 600 .local/platform/model.env
```

编辑私有 `model.env`，填入配置所引用的 `AGENT_MODEL_KEY`。也可以通过进程环境提供密钥；进程环境优先于文件。密钥文件支持一行一个 `NAME=value`，带空格的值使用引号。

```bash
python3 agent_environment.py doctor
python3 agent_environment.py start
```

从电脑转发 DSH 的 Web 端口：

```bash
ssh -N -L 3081:127.0.0.1:3080 you@host
```

另开终端，在 Host 运行以下命令取得适用于该转发的私有登录链接，然后在电脑的浏览器打开：

```bash
python3 agent_environment.py web --local-port 3081 --no-open --print
```

页面中选工作机与目录创建会话，再通过工作区控件切换到中心主机。同一会话保留历史，后续文件操作和命令跟随新的位置。也可以从另一台电脑打开同一页面，通过“接管输入”继续。

## 简化新设备接入

要让工作机通过下载包建立出站连接，在 DSH Host 上先准备一次安装器：

```bash
python3 agent_environment.py prepare-devices --ssh-host you@host.example.com
```

这里使用可从新设备访问的公开主机名；默认读取服务器自己的 `/etc/ssh/ssh_host_ed25519_key.pub`。自定义 SSH 端口通过 `--ssh-port` 指定。安装器使用该主机密钥验证服务器，并登记受限设备连接。

随后在 Web 点击“接入新设备”，选择目标系统、下载安装包并在目标机器运行。在目标项目目录执行 `dsh web --remote`，即可打开云端会话。安装器有效期为 15 分钟。Linux 已有真实安装验证；macOS 和 Windows 包处于预览阶段。

运行时状态、设备连接密钥和模型配置保存在 `.local/platform`；该目录由 Git 忽略。初始化拒绝覆盖已有目录，可通过 `--directory` 指定另一个空的新目录。备份和更新步骤见[部署说明](DEPLOYMENT.md)。
