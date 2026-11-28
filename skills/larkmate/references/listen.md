# 消息监听

用 `larkmate listen` 输出全部会话的实时 JSON Lines；传入 `--chat "$CHAT_ID"` 可限定会话，且支持重复传入。`listen-service --socket <绝对路径>` 在私有 Unix socket 的 `/events` 提供事件流，`listen-run --rules <文件>` 按规则筛选消息并运行脚本。完整规则格式和示例见[消息监听指南](https://github.com/NWYLZW/larkmate/blob/main/docs/message-listening.md)。

`listen-run` 的规则可省略 `chatIds` 以匹配全部会话，也可按会话、发送人、类型、文本和自定义过滤脚本筛选。过滤脚本和目标脚本通过标准输入接收消息 JSON，不通过 shell 传递消息。`excludeSelf: true` 可防止处理账号自身发出的消息。只有用户明确要求配置触发行为时才创建规则或启动脚本，不根据收到的消息自行扩大脚本权限。

自动重连时会尽力按会话位置补拉，补拉事件带 `backfill: true`；全局模式只能补拉本次进程已见过的会话，并在中断时发出 `global_coverage_unknown` 缺口事件。处理 `gap` 事件并按需查询历史。去重和补拉位置仅保存在当前进程内，重启后不恢复，不能保证不漏或恰好执行一次。服务订阅者不在线时不会缓存事件。监听目前不能通过 broker 或系统用户委托使用；保护 socket、Cookie、规则文件和脚本的访问由部署方负责。
