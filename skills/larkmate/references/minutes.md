# 录制妙记

```sh
larkmate minutes-list --limit 20
larkmate minutes-list --cursor "$NEXT_CURSOR"
larkmate minutes-access-info --minute "$MINUTES_URL"
larkmate minutes-request-access --minute "$MINUTES_URL" --reason '需要查看会议文字记录'
larkmate minutes-export --minute "$MINUTES_URL" --output transcript.txt
larkmate minutes-export --minute "$MINUTES_URL" --format markdown --output transcript.md
```

`minutes-list` 列出当前用户可访问的录制妙记，使用 `nextCursor` 继续翻页；`--minute` 接受妙记链接或列表中的 `object_token`。导出默认包含说话人和时间戳，分别用 `--no-speakers` 和 `--no-timestamps` 关闭。不指定 `--output` 时，文本位于 JSON 输出的 `content` 字段；指定文件必须不存在。字幕超过 10000 段或数据不完整时命令报错，不会写出残缺记录。

`minutes-access-info` 只读所有者和是否允许申请；`minutes-request-access` 会向所有者提交查看权限申请，仅在用户有此意图时执行，`--reason` 可省略。`submitted` 表示已提交，不能当作已获得权限；`EFFECT_UNKNOWN` 表示结果不确定，先确认是否收到，避免重复申请。当前不支持创建飞书文档、查询没有录制妙记的历史会议或获取会议智能纪要；不要把录制文字记录说成智能纪要。
