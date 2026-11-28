# 会话与消息

```sh
larkmate search --query '名称或关键词'
larkmate search-messages --query '消息关键词' --limit 20
larkmate search-messages --query '消息关键词' --cursor "$NEXT_CURSOR"
larkmate chats --limit 50
larkmate chats --cursor "$NEXT_CURSOR"
larkmate chats --parent "$BOX_ID"
larkmate group-query --group unread --pages 3
larkmate group-query --group at_me --query '关键词'
larkmate sidebar-list
larkmate sidebar-set --filter muted --visibility show --position 2
larkmate chat-info --chat "$CHAT_ID"
larkmate history --chat "$CHAT_ID" --limit 50 --pages 3
larkmate message-link --chat "$CHAT_ID" --message "$MESSAGE_ID"
larkmate download-file --chat "$CHAT_ID" --message "$MESSAGE_ID" --key "$RESOURCE_KEY" --output ./attachment
larkmate favorites --limit 50
larkmate messages-export --chat "$CHAT_ID" --output ./messages.md
larkmate messages-export --chat "$CHAT_ID" --sender "$MEMBER_ID" --after 1700000000 --before 1800000000 --format jsonl --output ./messages.jsonl
```

`chats` 默认读取收件箱的一页，不是全部历史会话。`--type`、`--state` 只过滤当前页，`--scope done` 查询已完成分组；`boxes` 用 `--parent` 单独读取，`nextCursor` 用于翻页。`history` 每页最多 100 个位置，`--pages` 最多 100 页；`--query`、`--sender`、`--after`、`--before` 只过滤已扫描的位置，不是全量搜索。`omittedPositions` 是没有返回的位置数，不是消息数；部分消息类型可能没有可解析正文。

`search-messages` 用于在当前用户可访问的会话范围内进行跨会话搜索，可使用 `nextCursor` 配合相同的查询条件继续翻页；具体搜索范围和结果由飞书服务决定。`message-link` 返回飞书生成的原生消息链接。`download-file` 根据 `history` 返回的资源键将文件或图片下载至新文件，不会覆盖已有文件；若下载中断，输出文件将不完整。`favorites` 用于读取收藏列表首页，其中 `hasMore` 表示可能仍有未返回的收藏。

使用受限代理或系统用户委托下载时，还须传入目标消息的 `--position`，取值为 `history` 返回的 `position`；执行器会核验消息和资源是否属于授权会话。文件大小受策略的 `maxFileBytes` 限制。

`messages-export` 会自动向前分页至会话最早位置，并按从新到旧的顺序输出 Markdown 或 JSON Lines。该命令支持 `--sender`、`--query`，以及以 Unix 秒为单位的 `--after` 和 `--before`；筛选范围仅限指定会话。可通过 `--max-pages` 限制页数，导出结束时需检查 `reachedBeginning`、`nextStart`、`nextLimit`、`omittedPositions` 和 `missingTimestamps`。

输出文件不会覆盖已有文件；若导出中断，文件中不会包含完成统计，须视为不完整。继续导出时，请使用新的输出文件，并将 `nextStart` 和 `nextLimit` 分别传给 `--start` 和 `--limit`，以避免分页重叠。

```sh
larkmate pinned
larkmate marked
larkmate chat-state --chat "$CHAT_ID"
larkmate chat-preferences --chat "$CHAT_ID"
larkmate chat-preferences-set --chat "$CHAT_ID" --mute-at-all true --auto-translate false
larkmate contact-alias --user "$USER_ID"
larkmate contact-alias-set --user "$USER_ID" --alias '备注名'
larkmate contact-note --user "$USER_ID"
larkmate contact-note-set --user "$USER_ID" --description '备注描述'
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

`chat-clear-history --chat "$CHAT_ID"` 清空当前用户的聊天记录，范围截止于调用时读取到的最后消息位置。该操作不可轻率调用，须有用户明确意图；返回 `submitted_unconfirmed` 时先检查记录，不盲目重试。

联系人备注仅对当前用户生效。`contact-note-set` 修改纯文本描述；备注包含图片或复杂格式时拒绝修改，以保护现有内容。传入空字符串可清除备注名或描述。`--mute-at-all` 控制是否屏蔽 @所有人提醒，`--auto-translate` 控制消息自动翻译，两者均使用 `true` 或 `false`。

`group-query` 支持消息、未读、免打扰、@我、单聊、群组、话题群、云文档、话题和已完成分组；可按名称筛选，使用 `nextCursor` 继续扫描。收纳盒需以 `--parent` 单独查询，`unknownState` 表示无法确定状态的数量。@我通过未读提及消息匹配会话，可能与飞书界面显示不同。标记和标签分别用 `marked`、`labels` 和 `label-chats` 查询。

`sidebar-set` 可以显示、隐藏或排序分组，并设置其在消息分组中的展示规则和 @所有人选项；使用 `larkmate sidebar-set --help` 查看参数。修改前先查询当前设置。
