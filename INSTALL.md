# LarkMate 快速安装

LarkMate 使用当前用户的飞书网页 Cookie，要求 Node.js 版本为 20 或更高。运行时无需安装 Lark CLI，也无需启动 Agent 服务。

## 方式一：让 AI 安装

把下面的内容发给有本机终端访问能力的 AI 编程助手：

```text
请按照 https://raw.githubusercontent.com/NWYLZW/larkmate/main/docs/ai-install.md 帮我安装并使用 LarkMate。
```

AI 可以执行安装和检查；访问飞书需要有效 Cookie。如果尚未配置登录态，按 AI 的指引在本机完成，或参考下方的“配置登录态”。

## 方式二：手动安装

### 1. 安装命令

从公共 npm 安装后检查命令：

```sh
node --version
npm install -g larkmate --registry=https://registry.npmjs.org/
larkmate --help
```

也可以在源码目录执行 `npm ci`，通过 `node bin/larkmate.js --help` 使用 CLI；开发时执行 `npm link` 可将全局命令链接到该源码目录。

### 2. 配置登录态

登录飞书网页版后，在浏览器开发者工具中查找当前登录会话的飞书网页请求，并复制完整的 `Cookie` 请求头。Cookie 可以代表你的账号操作，请仅在本机保存，不要发给其他人、粘贴到聊天或写进终端命令。

```sh
umask 077
mkdir -p ~/.larkmate
chmod 700 ~/.larkmate
```

用本机编辑器新建或更新 `~/.larkmate/credentials.json`，内容为如下 JSON，将占位文字替换为 Cookie 请求头的值：

```json
{"cookie": "在此填写完整 Cookie 请求头的值"}
```

保存后设置文件权限并检查登录：

```sh
chmod 600 ~/.larkmate/credentials.json
larkmate status
```

如果已有可用的凭据文件，直接执行 `larkmate status`，不必覆盖它。Cookie 失效时更新文件后重试。也可以通过 `LARKMATE_HOME` 选择配置目录、`LARKMATE_COOKIE` 提供 Cookie，或使用全局选项 `--credentials-file` 指定同格式文件；读取优先级依次为：指定文件、环境变量、配置目录。

### 3. 安装 Agent Skill

使用 [skills](https://github.com/vercel-labs/skills) 从项目仓库安装 Skill，按提示选择 Agent：

```sh
npx --registry=https://registry.npmjs.org/ skills add NWYLZW/larkmate --skill larkmate -g
```

`-g` 表示为当前用户全局安装；去掉 `-g` 可只安装到当前项目。npm 包中也包含 `skills/larkmate`，支持从已安装的包复制 Skill。新会话中可以使用 `$larkmate`，也可由 Agent 根据任务自动选择。

更多命令和能力边界见 [README](README.md)；Agent 的使用指引见 [SKILL.md](skills/larkmate/SKILL.md)。
