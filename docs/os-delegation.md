# 按系统用户委托 LarkMate

系统用户委托无需常驻服务：Agent 每次通过 `sudo` 启动受保护的执行器，执行器依据调用者的系统 UID 读取对应授权。策略允许的操作直接执行；其余受支持的操作交由该用户配置的审批脚本处理。只有审批脚本明确批准当前请求后，执行器才会执行飞书操作；调用完成后进程退出。原有的[本地代理模式](agent-broker.md)仍可使用。

## 安全边界

部署方须将 Agent 与 Cookie 所有者配置为不同的系统用户，确保 Agent 无法读取 Cookie，也无法修改受保护安装、Node.js 可执行文件及其依赖、启动器、策略文件、审批脚本或这些文件的上级目录，同时禁止 Agent 通过其他 `sudo` 规则以所有者身份运行任意程序。Agent 对其他文件的访问范围由系统账户或容器权限限制；策略文件无法限制 Agent 已有的系统权限。

以下为部署示例，请由系统管理员按实际路径和账户配置；LarkMate 不自动修改系统账户、文件权限或 `sudoers`。若没有满足这些条件，不能仅靠策略文件防止绕过或 Cookie 泄露。

## 策略文件

将 [示例配置](os-delegation.example.json) 复制到受保护安装包根目录的 `delegate-policy.json`。这个位置相对于安装包固定，不接受调用方指定。文件必须是所有者或 root 拥有的普通文件，不得允许组用户或其他用户写入；还应保护上级目录和 ACL。`ownerUid` 填写执行器所有者的 UID，`credentialsFile` 指向仅所有者可读的 Cookie 配置文件；`users` 的键是 Agent 的数字 UID。调用者 UID 未配置时直接拒绝，不进入审批。不能把所有者自身配置为 Agent。

每个用户的 `policy` 与[代理策略](agent-broker.md#配置授权)使用相同字段；只允许 `allow` 和资源范围共同匹配的操作。可通过 `larkmate delegate-commands` 查看可委托的命令及范围。可选的 `approvalScript` 必须是绝对路径、由所有者或 root 拥有的可执行普通文件，且不得允许组用户或其他用户写入；不配置时未授权操作直接拒绝。`approvalTimeoutSeconds` 默认 300 秒，可设为 1 至 600 秒。

文件、图片发送及附件下载可分别授权；上传文件由 Agent 进程读取，下载文件由 Agent 进程写入。执行器不接受 Agent 提供的所有者本地路径。下载时须提供 `history` 返回的 `--position`，执行器会核验会话、消息和资源键。单个文件受 `maxFileBytes` 限制；执行器在所有者私有临时目录中处理中转数据，正常结束或失败时删除，异常退出可能留下临时文件。部署方应保护、按需清理临时目录，并根据实际需要配置系统资源限制。

## 启动器与 sudoers 示例

将 LarkMate 包及依赖安装在 Agent 无法修改的受保护位置，将以下启动器放在同样受保护的位置。示例路径均须替换为实际绝对路径；Node.js 可执行文件和其依赖也不能由 Agent 修改。固定工作目录并清空环境，避免调用者通过环境变量或当前目录影响执行器。

```sh
#!/bin/sh
case "${SUDO_UID-}" in ''|*[!0-9]*) exit 1 ;; esac
cd /opt/larkmate/node_modules/larkmate || exit 1
umask 077
exec /usr/bin/env -i \
  SUDO_UID="$SUDO_UID" HOME=/absolute/owner/home PATH=/usr/bin:/bin \
  /absolute/protected/node \
  /opt/larkmate/node_modules/larkmate/bin/os-delegate-helper.js
```

例如，以下 sudoers 片段只允许 `agent` 以 `owner` 身份、不带额外参数运行这个启动器。必须先用 `visudo` 验证并由管理员安装，实际规则不能向 Agent 提供任意命令、`SETENV`、保留调用者环境或其他提权通道：

```sudoers
Cmnd_Alias LARKMATE_DELEGATE = /opt/larkmate/launch ""
Defaults!LARKMATE_DELEGATE env_reset
agent ALL=(owner) NOPASSWD: NOSETENV: LARKMATE_DELEGATE
```

执行器依赖 `sudo` 设置的 `SUDO_UID` 确定调用者；不要从 Agent 的环境、参数或文件中自行接收该 UID。启动器、策略、Node.js、依赖、审批脚本及上级目录的保护是部署前提，应检查 ACL 和已有的其他 sudo 规则。不要让 Agent 直接使用所有者账号。

在 Agent 环境中设置所有者名称和受保护启动器路径：

```sh
export LARKMATE_DELEGATE_OWNER=owner
export LARKMATE_DELEGATE_LAUNCHER=/opt/larkmate/launch
larkmate delegate-info
larkmate history --chat "$CHAT_ID" --limit 20
```

也可使用 `--delegate-owner` 和 `--delegate-launcher`。不可同时配置本地代理或指定 Cookie 文件。没有预设权限且配置了审批脚本时，调用会等待脚本结果。分页导出可能产生多次独立调用；若这些调用不在预设权限内，每次都会分别请求审批。

## 审批脚本协议

执行器不经 shell 直接启动脚本，通过标准输入发送一行 JSON；脚本通过标准输出返回一行 JSON，其他日志应写入标准错误。输入包含 `version`、随机 `requestId`、`callerUid` 和完整 `request`。发送文件或图片时还包含 `file.name`、`file.size` 和 `file.sha256`；摘要对应已收到的文件内容。脚本运行在所有者身份下，环境仅提供固定的 `PATH`、所有者 `HOME` 和 `LANG`。

脚本应把操作、目标及必要的内容呈现给所有者，可以自行发送卡片并等待确认。只有获得针对该 `requestId` 和对应请求的有效确认后，才以退出码 0 输出：

```json
{"decision":"allow","requestId":"输入中的 requestId"}
```

脚本必须自行验证卡片确认人的身份，确保确认绑定当前请求且不可重放。拒绝、超时、异常、非零退出码、输出过大、格式错误或 `requestId` 不匹配均视为拒绝。一次批准只用于当前调用，不更改策略文件，也不会绕过文件大小上限、请求格式检查或附件归属校验。审批内容可能包含消息正文和文件名，请按数据敏感程度保护脚本、审批渠道和日志。
