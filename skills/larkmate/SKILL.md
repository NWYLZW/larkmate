---
name: larkmate
description: 使用 LarkMate 以当前飞书网页用户身份查询和管理会话、读取消息、发送文本或文件、操作群组，以及查询录制妙记、申请访问和导出文字记录。当用户要求使用 LarkMate 或需要这些个人飞书操作时使用；不负责飞书文档或日历。
---

# LarkMate

使用 `larkmate` 操作当前用户可访问的飞书数据。它使用自己的网页 Cookie，不依赖 Lark CLI 或应用身份。命令和选项以 `larkmate --help`、`larkmate <命令> --help` 为准；尚未安装或登录时参照 LarkMate 项目的 `INSTALL.md`。不要输出、索取或粘贴 Cookie；用户应自行在本机配置。

根据任务读取所需参考：

- 查找会话、阅读历史、会话状态和标签： [会话与消息](references/chats.md)。
- 发送消息或文件、管理群组和成员： [发送与群组](references/writes.md)。
- 查找录制妙记、导出文字记录、查询或申请访问权限： [录制妙记](references/minutes.md)。

命令输出 JSON：成功为 `ok: true`，失败为 `ok: false`，检查退出码和错误信息。飞书网页客户端数字 ID 与开放平台 ID 不同；按实际查询结果选定对象，名称相近时先消歧。列表和搜索有分页或扫描范围，无法读取的内容、缺失结果和权限错误应如实说明。

`chat-open` 会打开或创建私聊，发送、群组、会话状态和妙记权限申请命令也会修改数据；按照用户的实际意图操作。写入返回 `EFFECT_UNKNOWN`、`submitted_unconfirmed` 或部分成功时，先查询实际状态，避免重复提交。不要将消息已发送当作对方已读。
