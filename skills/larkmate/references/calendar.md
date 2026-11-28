# 日历与日程

`calendars` 查询管理和订阅的日历；`calendar-search` 搜索联系人、会议室和共享日历。`calendar-events` 按时间范围查询并展开重复日程，默认查询主日历，可选择具体日历或全部日历。结束时间为开区间，一次最长查询 366 天；检查 `complete` 和 `warnings`。遇到无法展开的规则应说明，不要当作没有安排。

```sh
larkmate calendars
larkmate calendar-search --query '名称'
larkmate calendar-events --start '2026-11-30T00:00:00+08:00' --end '2026-12-01T00:00:00+08:00'
larkmate calendar-events --start '2026-11-30T00:00:00+08:00' --end '2026-12-07T00:00:00+08:00' --all-calendars
larkmate search --query '对方姓名'
larkmate calendar-events --user "$USER_ID" --start '2026-11-30T00:00:00+08:00' --end '2026-12-01T00:00:00+08:00'
larkmate calendar-busy --user "$USER_ID" --start '2026-11-30T10:00:00+08:00' --end '2026-11-30T10:30:00+08:00'
larkmate calendar-suggest --user "$USER_ID" --start '2026-11-30T00:00:00+08:00' --end '2026-12-07T00:00:00+08:00' --duration 30
larkmate event-get --id "$EVENT_ID"
larkmate calendar-rooms --start '2026-11-30T10:00:00+08:00' --end '2026-11-30T11:00:00+08:00' --query '会议室'
```

先通过姓名搜索确认用户，再使用忙闲命令；默认包含自己，可重复传入多个用户。忙闲仅在获得权限时可用，无权限或无法解析的用户不会当作空闲。查询他人日程时检查 `access` 的 `detailAccess`：只有忙闲权限时，返回时间可能没有主题和详情。建议默认只考虑工作日 09:00–18:00，可配置时区、工作时间和时长；检查 `complete` 与 `limitReached`。选定时间后，再按用户的实际要求创建日程并邀请参与人。

时间使用带时区的 ISO 时间或 Unix 秒。重复日程结果中的 `startTime`、`endTime` 和 `originalTime` 对应该次发生，`event` 是系列信息。修改或删除重复日程时根据用户意图传 `--span`（1 本次、2 本次及以后、3 整个系列）和 `--instance-start`；普通日程默认 span 0。日历返回的例外或规则若不完整，展开结果可能与网页不同，重要安排应核对详情。

```sh
larkmate event-create --title '讨论' --start '2026-11-30T10:00:00+08:00' --end '2026-11-30T10:30:00+08:00' --user "$USER_ID" --reminder 15
larkmate event-update --id "$EVENT_ID" --description '更新说明' --add-user "$USER_ID"
larkmate event-share --id "$EVENT_ID" --chat "$CHAT_ID"
larkmate event-reply --id "$EVENT_ID" --response accept
larkmate event-delete --id "$EVENT_ID"
larkmate calendar-create --name '团队日历'
larkmate calendar-update --id "$CALENDAR_ID" --description '说明'
larkmate calendar-subscribe --id "$CALENDAR_ID"
larkmate calendar-unsubscribe --id "$CALENDAR_ID"
```

`event-create` 和 `event-update` 支持参与人、群组和会议室；完整字段可用 `--json` 传入，结构见包内 `proto/calendar-schema.json` 的 `calendar_entities.WebCalendarEvent`。日历创建和更新的 `--json` 使用 `calendar_entities.WebCalendar` 字段，包括公开范围和共享成员。各字段是否可用取决于当前账号权限与飞书接口。命令选项以 `--help` 为准。

分享日程会向指定会话发送信息；创建、修改或删除日程可能通知参与人；`--no-notify` 请求不通知，具体行为由飞书决定。不要推断用户已授权邀请其他人或修改共享权限。写入返回 `submitted_unconfirmed`、`EFFECT_UNKNOWN` 或部分成功时，先查询实际状态，不盲目重试。
