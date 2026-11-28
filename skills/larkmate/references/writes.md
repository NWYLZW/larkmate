# 发送与群组

只在用户要求的目标和内容明确时发送消息或文件；从 `search`、`chats` 等结果取得网页客户端数字 ID，确认目标后再操作。`chat-open --id` 会打开或创建私聊。

```sh
larkmate send --chat "$CHAT_ID" --text '消息内容'
larkmate send --chat "$CHAT_ID" --text '回复内容' --reply-to "$MESSAGE_ID"
larkmate send --chat "$CHAT_ID" --text '@名称 消息内容' --mention "$MEMBER_ID:名称"
larkmate send-file --chat "$CHAT_ID" --file ./report.pdf
larkmate send-image --chat "$CHAT_ID" --file ./image.png
larkmate message-edit --message "$MESSAGE_ID" --text '修改后的文本'
larkmate message-recall --message "$MESSAGE_ID"
larkmate message-forward --chat "$CHAT_ID" --message "$MESSAGE_ID" --to "$TARGET_CHAT_ID"
larkmate reaction-add --message "$MESSAGE_ID" --emoji DarkThumbsup
larkmate reaction-remove --message "$MESSAGE_ID" --emoji DarkThumbsup
larkmate favorite-add --chat "$CHAT_ID" --message "$MESSAGE_ID"
larkmate favorite-remove --favorite "$FAVORITE_ID"
```

文件须为非空普通文件且不超过 100 MiB。`accepted` 表示服务器返回相应 ID，`submitted_unconfirmed` 表示未可靠确认接收；不确定时先检查实际状态再决定是否重试。

使用受限代理或系统用户委托发送文件或图片时，需要相应命令和目标会话的授权；文件由 Agent 自身读取，且还受策略 `maxFileBytes` 限制。

图片支持 PNG、JPEG、GIF 和 WebP 格式，大小不超过 10 MiB。`message-edit` 会以纯文本替换原消息内容，无法保留原有的富文本格式或提及。`--emoji` 需传入飞书表情名称，默认值为 `DarkThumbsup`。`favorite-add` 成功确认时会返回收藏 ID，供 `favorite-remove` 使用；该收藏 ID 也可从 `favorites` 首页获取。发送、编辑、撤回、转发、表情及收藏操作均须遵循用户的明确意图。

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
