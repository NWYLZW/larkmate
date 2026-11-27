# LarkMate

LarkMate 是一个以飞书用户身份工作的 CLI。它使用网页登录 Cookie，帮助 AI 助手和用户操作个人可访问的飞书信息。

## 安装

### 让 AI 安装

把下面的提示词发给有本机终端访问能力的 AI 助手：

```text
请按照 https://raw.githubusercontent.com/NWYLZW/larkmate/main/docs/ai-install.md 帮我安装并使用 LarkMate。
```

### 自己动手安装

需要 Node.js 20 或更新版本。运行以下命令，按提示选择要安装 Skill 的 AI 助手：

```sh
npm install -g larkmate --registry=https://registry.npmjs.org/
npx --registry=https://registry.npmjs.org/ skills add NWYLZW/larkmate --skill larkmate -g
```

登录配置和源码安装步骤见 [快速安装](INSTALL.md)。

## 支持的能力

- 查询会话与消息，发送文本和文件。
- 管理置顶、旗帜标记、已读与未读、免打扰、收纳和会话标签。
- 创建和管理群组，查询或邀请成员，管理机器人移除限制。
- 查询可访问的录制妙记、导出文字记录，以及向所有者申请访问权限。

具体用法和能力边界见 [LarkMate Skill](skills/larkmate/SKILL.md)。
