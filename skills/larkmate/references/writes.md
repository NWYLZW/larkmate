# 发送与群组

只在用户要求的目标和内容明确时发送消息或文件；从 `search`、`chats` 等结果取得网页客户端数字 ID，确认目标后再操作。`chat-open --id` 会打开或创建私聊。

```sh
larkmate send --chat "$CHAT_ID" --text '消息内容'
larkmate send --chat "$CHAT_ID" --text '回复内容' --reply-to "$MESSAGE_ID"
larkmate send --chat "$CHAT_ID" --text '@名称 消息内容' --mention "$MEMBER_ID:名称"
larkmate send-file --chat "$CHAT_ID" --file ./report.pdf
```

文件须为非空普通文件且不超过 100 MiB。`accepted` 表示服务器返回消息 ID，`submitted_unconfirmed` 表示未可靠确认接收；不确定时先查历史再决定是否重试。

回复已有回复时，需同时传入 `--reply-root`，其值取目标消息的 `rootId`；若目标消息是回复链的第一条，则只需传入 `--reply-to`。`history` 会返回每条消息的 `rootId` 和 `parentId`。

```sh
larkmate group-members --chat "$CHAT_ID"
larkmate group-create --name '群名称' --member "$MEMBER_ID"
larkmate group-invite --chat "$CHAT_ID" --member "$MEMBER_ID"
larkmate group-update --chat "$CHAT_ID" --name '新名称'
larkmate group-bot-info --chat "$CHAT_ID" --bot "$BOT_ID"
larkmate group-bot-protection --chat "$CHAT_ID" --bot "$BOT_ID" --allow-member-removal
larkmate group-dissolve --chat "$CHAT_ID"
```

`--member` 可重复指定。创建或邀请机器人默认限制普通成员移除，`--allow-member-removal` 可关闭该限制。`verified` 只表示机器人移除限制已读回。遇到 `GROUP_CREATED_PARTIAL` 或 `INVITE_PARTIAL` 时，先检查已产生的群或成员变化，不要盲目重复操作。
