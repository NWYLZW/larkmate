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
larkmate chats --state unread
larkmate chats --scope done --state read
larkmate chats --parent "$BOX_ID"
larkmate search --query '机器人名称'
larkmate chat-open --id "$MEMBER_ID"
larkmate chat-info --chat "$CHAT_ID"
larkmate history --chat "$CHAT_ID" --limit 50 --pages 3
larkmate history --chat "$CHAT_ID" --pages 3 --query '关键词' --sender "$MEMBER_ID"
larkmate history --chat "$CHAT_ID" --after 1700000000 --before 1800000000
```

`chats` 默认只读收件箱，`--scope done` 可读已完成分组，每次最多取 100 张卡片，`nextCursor` 用于继续翻页。返回的 `boxes` 是折叠会话盒子，使用 `--parent` 单独读取；`--type` 仅筛选当前页，其他类型的卡片不会计入结果。`--state read|unread` 也仅筛选当前页；无法判断状态的会话不列入结果，并计入 `unknownReadState`。它不是所有历史会话的完整清单。`chat-open` 会打开或创建私聊，不是只读操作。

`history` 默认从最新消息位置向前读取，每页最多 100 个位置，`--pages` 最多扫描 100 页。结果按位置从旧到新排列；`nextStart` 和 `nextLimit` 可用于续读更早的位置。位置可能不存在、已删除或不可见，`omittedPositions` 表示未返回的位置数，不能当作消息数量。关键词、发送者及 Unix 秒级时间筛选只作用于本次扫描的范围，不代表全量搜索；按时间筛选时，`missingTimestamps` 统计因缺少时间而无法判断的消息数。部分会话没有返回最新位置时，需通过 `--start` 指定位置。

文本和富文本会返回可解析文本，文件和图片尽可能返回资源元数据；卡片等未支持解析的类型保留类型和消息 ID，正文可能为空。

## 会话管理

`pinned` 和 `marked` 分别查询置顶会话和旗帜标记的会话；`chat-state` 读取单个会话的置顶、标记、免打扰、未读、已完成及收纳状态。

```sh
larkmate pinned
larkmate marked
larkmate chat-state --chat "$CHAT_ID"
larkmate pin --chat "$CHAT_ID"
larkmate unpin --chat "$CHAT_ID"
larkmate mark --chat "$CHAT_ID"
larkmate unmark --chat "$CHAT_ID"
larkmate unread --chat "$CHAT_ID"
larkmate read --chat "$CHAT_ID"
larkmate mute --chat "$CHAT_ID"
larkmate unmute --chat "$CHAT_ID"
larkmate done --chat "$CHAT_ID"
larkmate inbox --chat "$CHAT_ID"
larkmate box --chat "$CHAT_ID"
larkmate unbox --chat "$CHAT_ID"
```

`mark` 是会话右键菜单中的旗帜“标记”。`read` 会将阅读位置推进到调用时的最新可见消息，并清除手动未读标记；`unread` 可能把已完成会话重新放回收件箱。`done` / `inbox` 管理已完成状态，`box` / `unbox` 管理会话收纳。状态更改后会读回核验；`submitted_unconfirmed` 表示已提交但未能确认，应先查状态再决定是否重试。

## 会话标签

```sh
larkmate labels
larkmate label-chats --label "$LABEL_ID"
larkmate label-create --name '项目协作'
larkmate label-rename --label "$LABEL_ID" --name '项目讨论'
larkmate label-add --label "$LABEL_ID" --chat "$CHAT_ID"
larkmate label-remove --label "$LABEL_ID" --chat "$CHAT_ID"
larkmate label-delete --label "$LABEL_ID"
```

标签 ID 取自 `labels` 或 `label-create`。会话添加和移除目前只支持手动管理的标签；自动规则标签不支持修改成员。删除标签会删除整个个人标签，请使用准确的标签 ID。

## 历史会议与纪要

会议功能使用可选的官方 `lark-cli` 和其已登录的**用户身份**；它的账号和权限独立于 LarkMate 的 Cookie。结果中的 `source` 会显示实际使用的身份，使用前请确认是预期账号。没有安装、登录或缺少权限时，命令会返回明确错误，不会自动切换为机器人身份。

```sh
larkmate meeting-search --mine --start 2026-11-01 --end 2026-11-27
larkmate meeting-search --query '会议标题或九位会议号'
larkmate meeting-info --meeting "$MEETING_ID"
larkmate meeting-note --meeting "$MEETING_ID"
larkmate meeting-minutes --meeting "$MEETING_ID"
```

`meeting-search` 只搜索已结束会议，`--mine` 限定为所选官方用户参加的会议；结果支持通过 `--page-token` 翻页，时间范围最多一个月。后续命令使用搜索结果中的长数字会议 ID，不是九位会议号。`meeting-note` 读取会议关联的智能纪要文档；`meeting-minutes` 查询录制妙记的总结、待办和章节。智能纪要和录制妙记是不同产物，可能分别缺失或有不同的访问权限。

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
