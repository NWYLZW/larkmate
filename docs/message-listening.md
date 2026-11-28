# 监听飞书消息

LarkMate 使用当前用户的飞书 Cookie 监听指定会话。先通过 `search` 或 `chats` 确认会话 ID，监听不会主动标记消息为已读。监听进程需要持续运行；退出后不会在后台继续收取消息。

## 本地事件服务

```sh
mkdir -p "$HOME/.larkmate/events"
chmod 700 "$HOME/.larkmate/events"
larkmate listen-service --socket "$HOME/.larkmate/events/messages.sock" --chat "$CHAT_ID"
```

可重复传入 `--chat`。其他本机程序通过 Unix socket 订阅 JSON Lines：

```sh
curl -N --unix-socket "$HOME/.larkmate/events/messages.sock" http://localhost/events
```

socket 为 `0600`，父目录必须归当前用户所有且不能被其他用户写入。所有连接者接收启动时指定的全部会话；订阅者不在线时不保存事件。也可用 `larkmate listen --chat "$CHAT_ID"` 直接向标准输出流式输出，不启动服务。

## 规则与脚本

创建私有 JSON 文件，例如：

```json
{
  "version": 1,
  "rules": [
    {
      "name": "process-request",
      "chatIds": ["123456789"],
      "senderIds": ["987654321"],
      "types": [4],
      "contains": "需要处理",
      "excludeContains": "无需处理",
      "excludeSelf": true,
      "filter": { "path": "/absolute/path/filter", "args": [], "timeoutSeconds": 10 },
      "run": { "path": "/absolute/path/handler", "args": [], "timeoutSeconds": 30 }
    }
  ]
}
```

执行 `chmod 600 rules.json`，将示例 ID 和脚本路径改为实际值，然后运行：

```sh
larkmate listen-run --rules ./rules.json
```

`chatIds` 和 `run` 必填；每条规则至少指定一个会话。其他筛选项可省略，填写的条件同时生效。`types` 使用消息类型数字，`4` 表示文本；`contains` 和 `excludeContains` 区分大小写。`excludeSelf` 为 `true` 时跳过当前账号发送的消息。

过滤器和目标脚本均为固定的绝对可执行文件路径，`args` 为固定参数；消息不会经由 shell 解析。每次调用时，通过标准输入传入一行消息 JSON。过滤器退出码 `0` 表示匹配，`1` 表示不匹配，其余退出码或超时均视为错误；仅在匹配成功时执行 `run`。过滤器和脚本的标准输出与标准错误不会被转发，失败信息写入监听进程的标准错误。脚本默认超时时间为 30 秒，可配置为 1–600 秒。规则按顺序执行，脚本执行失败不会自动重试。

规则文件必须由当前用户或 root 拥有，不能对组或其他用户开放写权限。脚本以启动监听进程的系统用户身份运行；部署方应保护规则文件、脚本及其目录。监听服务和规则模式目前使用持有 Cookie 的账号直接运行，不能通过受限 broker 或系统用户委托调用。

## 事件与恢复

`message` 事件包含 `id`、`chatId`、`senderId`、`position`、`type`、`text`、`createTime` 等字段。文本无法完整解析时 `textIncomplete` 为 `true`；其他消息类型的 `text` 可能为 `null`。规则模式仅对 `message` 执行脚本，`gap` 事件写到标准错误。

连接中断后会自动重连，并在进程保持运行期间按会话位置尽力补拉消息；补拉的消息带有 `backfill: true` 标记。若出现补拉失败、位置不可读或超出补拉上限等情况，会输出 `gap`，调用方应检查并按需通过 `history` 补查。去重状态与会话位置均保存在内存中，进程重启后不会恢复；不保证事件不丢失，也不保证脚本恰好执行一次。
