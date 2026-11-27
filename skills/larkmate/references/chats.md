# 会话与消息

```sh
larkmate search --query '名称或关键词'
larkmate chats --limit 50
larkmate chats --cursor "$NEXT_CURSOR"
larkmate chats --parent "$BOX_ID"
larkmate chat-info --chat "$CHAT_ID"
larkmate history --chat "$CHAT_ID" --limit 50 --pages 3
larkmate messages-export --chat "$CHAT_ID" --output ./messages.md
larkmate messages-export --chat "$CHAT_ID" --sender "$MEMBER_ID" --after 1700000000 --before 1800000000 --format jsonl --output ./messages.jsonl
```

`chats` 默认读取收件箱的一页，不是全部历史会话。`--type`、`--state` 只过滤当前页，`--scope done` 查询已完成分组；`boxes` 用 `--parent` 单独读取，`nextCursor` 用于翻页。`history` 每页最多 100 个位置，`--pages` 最多 100 页；`--query`、`--sender`、`--after`、`--before` 只过滤已扫描的位置，不是全量搜索。`omittedPositions` 是没有返回的位置数，不是消息数；部分消息类型可能没有可解析正文。

`messages-export` 会自动向前分页至会话最早位置，并按从新到旧的顺序输出 Markdown 或 JSON Lines。该命令支持 `--sender`、`--query`，以及以 Unix 秒为单位的 `--after` 和 `--before`；筛选范围仅限指定会话。可通过 `--max-pages` 限制页数，导出结束时需检查 `reachedBeginning`、`nextStart`、`nextLimit`、`omittedPositions` 和 `missingTimestamps`。

输出文件不会覆盖已有文件；若导出中断，文件中不会包含完成统计，须视为不完整。继续导出时，请使用新的输出文件，并将 `nextStart` 和 `nextLimit` 分别传给 `--start` 和 `--limit`，以避免分页重叠。

```sh
larkmate pinned
larkmate marked
larkmate chat-state --chat "$CHAT_ID"
larkmate pin --chat "$CHAT_ID"       # 取消置顶：unpin
larkmate mark --chat "$CHAT_ID"      # 取消旗帜标记：unmark
larkmate unread --chat "$CHAT_ID"    # 标为已读：read
larkmate mute --chat "$CHAT_ID"      # 取消免打扰：unmute
larkmate done --chat "$CHAT_ID"      # 回到收件箱：inbox
larkmate box --chat "$CHAT_ID"       # 取消收纳：unbox
larkmate labels
larkmate label-chats --label "$LABEL_ID"
larkmate label-add --label "$LABEL_ID" --chat "$CHAT_ID"
larkmate label-remove --label "$LABEL_ID" --chat "$CHAT_ID"
```

`mark` 对应聊天右键菜单的旗帜“标记”。`read` 会推进到调用时最新可见位置并清除手动未读标记；`unread` 可能把已完成会话放回收件箱。标签创建、重命名和删除分别使用 `label-create`、`label-rename`、`label-delete`，会话成员调整仅支持手动标签。删除标签会删除整个个人标签。
