# 飞书任务

`task-center` 查询任务中心及视图；`tasks-list` 支持 mine、followed、all、created、assigned 和 completed 视图。可按关键词搜索、读取、新建、编辑、完成、重开和删除任务。

`tasks-list` 使用返回的 `nextCursor` 继续分页；任务列表发生变化时需从头查询。注意 `missing` 和 `serverReportedAllTasks`，不要把服务端未返回的任务当成不存在。

```sh
larkmate task-center
larkmate tasks-list --scope mine --limit 50
larkmate tasks-list --scope mine --cursor "$NEXT_CURSOR"
larkmate task-search --query '关键词'
larkmate task-get --id "$TASK_ID"
larkmate task-create --title '任务标题' --description '说明' --due '2026-12-01T18:00:00+08:00' --assignee "$USER_ID" --follower "$FOLLOWER_ID"
larkmate task-update --id "$TASK_ID" --due '2026-12-02T18:00:00+08:00' --add-assignee "$USER_ID"
larkmate task-complete --id "$TASK_ID"
larkmate task-reopen --id "$TASK_ID"
larkmate task-delete --id "$TASK_ID"
```

开始和截止时间可用毫秒时间戳或 ISO 日期；更新时用 `0` 清除时间。创建支持全天、重复规则、所属清单和积分等选项，使用 `task-create --help` 查看。`--json` 可从调用方本地文件或标准输入读取完整 `todo_entities.InputTask` JSON，提供提醒、子任务、附件引用和自定义字段等高级配置；字段结构参照包内 `proto/todo-schema.json`。常用参数覆盖 JSON 中对应字段。更新支持标题、描述、时间、重复规则、里程碑、积分、负责人和关注人；`--commits-json` 接受高级字段的原生提交数组（`key`、`dataType`、Base64 编码的 `added`/`deleted`），结构参照同一协议文件。高级字段能否使用由飞书接口和当前用户权限决定。

写入返回 `EFFECT_UNKNOWN`、`submitted_unconfirmed`、部分成功或拒绝时，先重新读取任务并核对状态，不要盲目重试。任务创建、修改、完成和删除会改变飞书数据，只在用户授权范围内操作。
