# LarkMate

LarkMate 是一个独立的飞书用户身份命令行工具，可以查询会话、读取消息、发送文本和文件，以及管理群组。它使用已登录用户的 Cookie，通过飞书网页客户端接口工作，不需要启动 Agent 服务。

## 安装与登录

需要 Node.js 20 或更新版本。在项目目录执行 `npm install`，使用 `node bin/larkmate.js --help` 查看命令；执行 `npm link` 后可直接使用 `larkmate`。

默认从 `~/.larkmate/credentials.json` 读取登录信息，格式为 `{ "cookie": "..." }`。将目录和文件分别设为仅当前用户可访问（权限 `700` 和 `600`）。也可以通过 `LARKMATE_HOME` 指定配置目录，或通过 `LARKMATE_COOKIE` 提供 Cookie；`--credentials-file` 可指定其他相同格式的文件。读取顺序为指定文件、环境变量、配置目录。不要把真实 Cookie 写进命令参数、聊天记录或代码仓库。Cookie 过期后需更新，再用 `larkmate status` 检查。

## 查询会话与消息

命令输出 JSON。会话使用飞书网页客户端的数字 ID，与开放平台的 `open_id` 和 `chat_id` 不同。

```sh
larkmate chats --limit 50
larkmate chats --type group --cursor "$NEXT_CURSOR"
larkmate chats --parent "$BOX_ID"
larkmate search --query '机器人名称'
larkmate chat-open --id "$MEMBER_ID"
larkmate chat-info --chat "$CHAT_ID"
larkmate history --chat "$CHAT_ID" --limit 50 --pages 3
larkmate history --chat "$CHAT_ID" --pages 3 --query '关键词' --sender "$MEMBER_ID"
larkmate history --chat "$CHAT_ID" --after 1700000000 --before 1800000000
```

`chats` 只读当前收件箱，每次最多取 100 张卡片，`nextCursor` 用于继续翻页。返回的 `boxes` 是折叠会话盒子，使用 `--parent` 单独读取；`--type` 仅筛选当前页，其他类型的卡片不会计入结果。它不是所有历史会话的完整清单。`chat-open` 会打开或创建私聊，不是只读操作。

`history` 默认从最新消息位置向前读取，每页最多 100 个位置，`--pages` 最多扫描 100 页。结果按位置从旧到新排列；`nextStart` 和 `nextLimit` 可用于续读更早的位置。位置可能不存在、已删除或不可见，`omittedPositions` 表示未返回的位置数，不能当作消息数量。关键词、发送者及 Unix 秒级时间筛选只作用于本次扫描的范围，不代表全量搜索；按时间筛选时，`missingTimestamps` 统计因缺少时间而无法判断的消息数。部分会话没有返回最新位置时，需通过 `--start` 指定位置。

文本和富文本会返回可解析文本，文件和图片尽可能返回资源元数据；卡片等未支持解析的类型保留类型和消息 ID，正文可能为空。

## 发送消息和文件

```sh
larkmate send --chat "$CHAT_ID" --text '你好'
larkmate send --chat "$CHAT_ID" --text '@机器人名称 你好' --mention "$MEMBER_ID:机器人名称"
larkmate send-file --chat "$CHAT_ID" --file ./report.pdf
```

文件须为非空普通文件，大小不超过 100 MiB；上传按块校验，成功后发送一条文件消息。`accepted` 表示服务器返回了消息 ID，`submitted_unconfirmed` 表示请求已提交但没有可靠的接收确认；都不代表对方已经阅读。遇到不确定结果时，先查看会话历史，避免重复发送。

## 群组与机器人

```sh
larkmate group-create --name '群名称' --description '群介绍' --member "$MEMBER_ID"
larkmate group-invite --chat "$CHAT_ID" --member "$MEMBER_ID"
larkmate group-members --chat "$CHAT_ID"
larkmate group-update --chat "$CHAT_ID" --name '新群名' --description '新介绍'
larkmate group-dissolve --chat "$CHAT_ID"
larkmate group-bot-info --chat "$CHAT_ID" --bot "$BOT_ID"
larkmate group-bot-protection --chat "$CHAT_ID" --bot "$BOT_ID" --allow-member-removal
```

`--member` 可重复传入。CLI 会先识别普通用户与机器人，无法确认类型时停止执行。创建或邀请机器人时，默认开启「仅群主和添加者可移除」；指定 `--allow-member-removal` 可关闭此限制。`group-update --description ''` 可清空群介绍。实际操作取决于当前用户和群的权限。

`verified` 只表示机器人的移除限制已读回，不表示消息已送达。`EFFECT_UNKNOWN` 表示写入结果未知；`GROUP_CREATED_PARTIAL` 和 `INVITE_PARTIAL` 表示部分步骤可能已生效。此时先检查实际状态，再决定是否重试。群成员分页支持 `--cursor`、`--offset` 和 `--limit`。

网页客户端接口可能变化，也可能受企业策略影响。创建、邀请、群资料修改、机器人限制和解散曾在临时群验证；普通用户邀请只经过模拟测试。协议来源和第三方许可见 [third_party/NOTICE.md](third_party/NOTICE.md)。
