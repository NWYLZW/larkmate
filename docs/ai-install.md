# 给 AI 助手的 LarkMate 安装与使用说明

用户提供此文件，是希望你在其电脑上安装和使用 LarkMate。LarkMate 使用飞书网页的用户 Cookie，独立于 Lark CLI 和其他 Agent 服务。按用户指定的安装范围执行；未指定时，为当前用户全局安装 CLI 和当前 AI 助手的 Skill。

## 安装与检查

1. 检查 Node.js 和 npm；LarkMate 要求 Node.js 20 或更新版本。版本不满足时，优先使用已有的版本管理器安装合适版本；不能自行完成时说明原因。
2. 检查 `larkmate --version`，以及当前助手是否已有可用的 LarkMate Skill。保留有效的已有安装和登录配置，不覆盖不属于 LarkMate 的同名文件。
3. 需要安装或更新 CLI 时，从公共 npm 安装：

   ```sh
   npm install -g larkmate --registry=https://registry.npmjs.org/
   ```

4. 需要安装 Skill 时，使用标准 Skill 安装器，从项目仓库安装 `larkmate`。非交互环境中，指定当前助手支持的 `--agent` 并加 `-y`；例如 Codex 使用 `-a codex -y`。不要覆盖其他来源的同名 Skill。

   ```sh
   npx --registry=https://registry.npmjs.org/ skills add NWYLZW/larkmate --skill larkmate -g
   ```

5. 通过 `larkmate --version` 和 `larkmate --help` 检查实际调用的命令，并检查当前助手的 Skill 文件及其引用是否可用。若 `PATH` 仍指向其他安装，说明实际状态并修正适合当前环境的入口，不要只根据安装命令的退出码宣称成功。

## 登录与使用

若环境中已配置 `LARKMATE_DELEGATE_OWNER` 和 `LARKMATE_DELEGATE_LAUNCHER`，请先运行 `larkmate delegate-info`，通过系统用户委托使用 LarkMate，无需读取或配置 Cookie。遇到权限不足时遵循审批结果，不尝试绕过；具体部署见 [系统用户权限委托](https://github.com/NWYLZW/larkmate/blob/main/docs/os-delegation.md)。

若运行环境中已配置 `LARKMATE_BROKER` 和 `LARKMATE_BROKER_TOKEN_FILE`，请先运行 `larkmate broker-info`，通过受限代理使用 LarkMate，无需读取或配置 Cookie。当代理权限不足时，应说明具体情况，由所有者决定是否调整权限；具体部署见 [Agent 权限委托指南](https://github.com/NWYLZW/larkmate/blob/main/docs/agent-broker.md)。

未使用系统用户委托或受限代理时，LarkMate 默认从 `~/.larkmate/credentials.json` 读取 Cookie，也支持 `LARKMATE_HOME`、`LARKMATE_COOKIE` 和 `--credentials-file`。先保留并检查已有登录态，可用 `larkmate status` 验证；不要读取或打印 Cookie 的值到对话、日志或命令参数中。

如果没有可用登录态，引导用户在本机安全配置，不要要求用户把 Cookie、密码或验证码发到对话中。配置格式和手动步骤见 [快速安装](https://github.com/NWYLZW/larkmate/blob/main/INSTALL.md)。不能自动完成登录时，如实说明，不声称已经登录。

安装后按需读取已安装 Skill 的 `SKILL.md` 和相关参考文件，依照用户的具体要求使用 CLI。当前能力包括会话与消息、会话管理和标签、群组管理、录制妙记及文字记录；以实际 CLI 帮助和 Skill 说明为准。发送消息、文件、权限申请及其他写操作应有用户指示；对于结果不确定的写入，先核查状态，避免重复提交。

完成安装和检查后，报告 CLI、Skill 与登录态的实际状态。若用户同时给出了具体的飞书操作，在权限和登录态允许时继续完成该操作。
