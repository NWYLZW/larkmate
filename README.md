# LarkMate

以已登录的飞书用户身份进行搜索、聊天及群组管理。该工具复用现有 `feishu-user-plugin` 的 Cookie 配置，独立运行，无需启动 Agent 服务。

## 安装与登录

需要 Node.js 20 或更新版本。在项目目录执行 `npm install`，之后可使用 `node bin/feishu-user.js --help`。如需全局命令，可执行 `npm link`，再使用 `feishu-user`。

登录配置按以下顺序读取：

1. `--credentials-file` 指定的 Cookie 文件或兼容的 `credentials.json`。
2. `FEISHU_USER_COOKIE` 或 `LARK_COOKIE` 环境变量。
3. `FEISHU_USER_PLUGIN_CREDENTIALS_DIR/credentials.json`；未设置时使用 `~/.feishu-user-plugin/credentials.json`。

不会修改原配置。Cookie 失效后需要更新原配置；不要把 Cookie 放进命令参数、聊天或代码仓库。用 `feishu-user status` 检查登录状态。

## 常用命令

命令输出 JSON。先搜索，使用结果中的数字 ID；它不同于开放平台的 `open_id`。

```sh
feishu-user search --query '机器人名称'
feishu-user chat-open --id "$MEMBER_ID"
feishu-user chat-info --chat "$CHAT_ID"
feishu-user history --chat "$CHAT_ID" --limit 20
feishu-user send --chat "$CHAT_ID" --text '你好'
feishu-user send --chat "$CHAT_ID" --text '@机器人名称 你好' --mention "$MEMBER_ID:机器人名称"
```

`history` 默认读取最新的消息位置；`--start` 可指定起始位置，每次最多读取 100 个位置。部分消息类型目前只返回类型和 ID，文本可能为空。

## 群组与机器人

```sh
feishu-user group-create --name '群名称' --description '群介绍' --member "$MEMBER_ID"
feishu-user group-invite --chat "$CHAT_ID" --member "$MEMBER_ID"
feishu-user group-members --chat "$CHAT_ID"
feishu-user group-update --chat "$CHAT_ID" --name '新群名' --description '新介绍'
feishu-user group-dissolve --chat "$CHAT_ID"
```

`--member` 可重复传入。CLI 会先识别普通用户与机器人，无法确认类型时停止执行。普通用户按群成员方式邀请，机器人按机器人方式邀请。创建或邀请机器人时，默认开启「仅群主和添加者可移除」；指定 `--allow-member-removal` 可关闭这一限制。`group-update --description ''` 可清空群介绍。操作是否允许取决于当前用户和群的权限。

已有机器人的限制可单独读取或修改：

```sh
feishu-user group-bot-info --chat "$CHAT_ID" --bot "$BOT_ID"
feishu-user group-bot-protection --chat "$CHAT_ID" --bot "$BOT_ID"
feishu-user group-bot-protection --chat "$CHAT_ID" --bot "$BOT_ID" --allow-member-removal
```

## 结果与限制

- `submitted_unconfirmed` 表示请求已提交，但没有确认最终结果；查看群成员或消息历史后再决定是否重试。
- 机器人的 `verified` 只表示移除限制已从飞书读回，不等同于消息已送达。`created_protection_unconfirmed` 表示群已创建，但至少一个机器人的限制尚未确认。
- `EFFECT_UNKNOWN` 表示写入结果未知；`GROUP_CREATED_PARTIAL` 或 `INVITE_PARTIAL` 表示部分步骤可能已经生效。错误详情会保留已创建的群和已提交步骤，先检查实际状态，避免重复操作。
- 不支持判断的成员类型会被拒绝。群成员分页可用 `--cursor`、`--offset` 和 `--limit`。
- 使用飞书客户端的内部接口，接口变化或企业策略可能影响可用性。创建、邀请、群资料修改、机器人限制和解散已在临时群验证；普通用户邀请已通过模拟测试，尚未邀请真实同事验证。

协议来源和第三方许可见 [third_party/NOTICE.md](third_party/NOTICE.md)。
