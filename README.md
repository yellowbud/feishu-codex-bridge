# Feishu Codex Bridge

把飞书机器人接到本机 Codex CLI。你在飞书里发消息，macmini 上的 Codex 执行任务，再把结果发回飞书。

## 快速开始

```bash
git clone https://github.com/yellowbud/feishu-codex-bridge.git
cd feishu-codex-bridge
npm install
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

启动：

```bash
npm start
```

保持后台在线：

```bash
npm run install-service
npm run service-status
tail -f logs/bridge.log
```

## 飞书配置

在飞书开放平台创建企业自建应用：

1. 启用「机器人」。
2. 使用「长连接」事件模式。
3. 订阅事件：`im.message.receive_v1`。
4. 私聊消息需要机器人消息权限。
5. 群里不 `@机器人` 也要收到消息时，开启权限：`获取群组中所有消息` / `im:message.group_msg`。
6. 需要直接发送图片/文件时，开启权限：`获取消息中的资源文件`。
7. 需要 Codex 发回图片/文件时，开启上传图片、上传文件、发送图片/文件消息相关权限。
8. 需要 Codex 创建 specs/docs 飞书文档时，开启创建、编辑新版云文档（docx）相关权限。
9. 需要给任意消息点表情后一键转给 Codex 时，订阅事件：`im.message.reaction.created_v1`，并开启获取指定消息内容相关权限。
10. 需要可交互卡片按钮时，订阅卡片回调事件：`card.action.trigger`。
11. 需要 `/new chat` 自动建群时，开启创建群与拉用户入群相关权限。
12. 改权限后重新发布应用版本，并把机器人加入目标群。

如果没有 `im:message.group_msg`，飞书通常只会把 `@机器人` 的群消息投递给应用。

## 飞书里怎么用

在私聊或已授权群里，像平时聊天一样直接发需求：

```text
帮我检查这个项目
```

图片和文件也可以直接发。Bridge 会先把它们下载到本机，再把可读取的本机路径交给 Codex。

看到群里已有消息想让 Codex 处理，不用复制粘贴：给那条消息点机器人表情 reaction，它会在同一个 thread 里接着处理。

所有过程都会沉淀在飞书 thread 里：原消息、任务卡片、输入摘要、最终回复、表格、文档和附件都会回写，后面搜索、存档、回顾、分享都方便。本机 `data/` 只作为运行缓存。

Codex 的回复也不只限于纯文字。它可以把本机生成的图片、PDF、截图、压缩包发回飞书，也可以直接创建飞书文档、渲染表格，或发一张可点击的交互卡片。

### 会话

| 命令 | 作用 |
| --- | --- |
| `/new` 或 `/reset` | 清空当前 thread 的 Codex session，从零开始 |
| `/new <任务>` | 开新 session 并立刻执行任务 |
| `/new chat <名字>` | 自动创建新 project 群，并继承当前 cwd |
| `/resume [N]` | 列出最近 N 个历史 session，点按钮恢复 |
| `/status` | 查看当前 cwd、workspace、session 和运行状态 |
| `/help` | 查看命令速查卡片 |

一个群就是一个 project。话题群里的每个话题、普通群里的每个 thread，都是独立 Codex session。

### 工作目录

| 命令 | 作用 |
| --- | --- |
| `/cd <路径>` | 切换当前会话的 cwd，并重置 session |
| `/ws list` | 查看所有命名 workspace |
| `/ws save <名字>` | 把当前 cwd 保存成 workspace |
| `/ws use <名字>` | 切到指定 workspace |
| `/ws remove <名字>` | 删除 workspace |

每个 workspace 都有自己的 Codex session，切回来会接着之前的上下文。

### 运行控制

| 命令 | 作用 |
| --- | --- |
| `/stop` | 终止当前 thread 正在跑的任务 |
| `/cancel <taskId>` | 按任务 ID 取消 |
| `/timeout` | 查看当前 session 的 run 探活 |
| `/timeout 15` | 15 分钟无输出自动 kill |
| `/timeout off` | 当前 session 关闭探活 |
| `/timeout default` | 清掉 session 覆盖，跟随全局 |
| `/reconnect` | 强制重连 Feishu WebSocket |

任务开始卡片底部的 `⏹ 终止` 按钮等同于 `/stop`。

### 设置与诊断

| 命令 | 作用 |
| --- | --- |
| `/config` | 打开偏好设置卡片 |
| `/account` | 查看当前绑定的飞书应用 |
| `/account change <appId> <appSecret>` | 热切换应用凭据 |
| `/ps` | 列出本机 bridge 进程，并标出当前回复进程 |
| `/exit #1` 或 `/exit <pid>` | 终止指定 bridge 进程 |
| `/doctor [描述]` | 用最近日志生成故障诊断 |

`/config` 用来调整日常使用偏好，比如回复用卡片还是纯文本、是否展示工具调用、并发上限，以及群里是否必须 @ bot 才响应。切换应用凭据时建议在私聊里用 `/account change`，避免 secret 留在群记录里。`/exit` 只会关闭 `/ps` 列出的 bridge 进程：关闭当前进程会先 graceful 退出，关闭其他进程会发送 SIGTERM。

### 飞书原生输出

让 Codex 输出这些代码块，桥接会自动渲染成飞书内容：

````text
```feishu-doc title="项目 spec"
# 标题
...
```

```feishu-table title="数据表"
| 名称 | 状态 |
| --- | --- |
| A | done |
```

```feishu-actions
{"title":"选择下一步","actions":[{"label":"继续","prompt":"继续处理"}]}
```
````

Codex 生成本机图片或文件后，只要在最终回复里写出绝对路径或 Markdown 链接，桥接会自动上传为飞书附件。默认只允许当前 workspace、`CODEX_CWD`、`data/` 和 `/private/tmp` 下的文件。

## 访问控制

默认开启访问控制，状态保存在 `data/access.json`，不会提交到 Git。

新私聊用户会收到配对码，在本机批准：

```bash
npm run access -- pair <code>
```

常用管理命令：

```bash
npm run access
npm run access -- allow <senderOpenId>
npm run access -- remove <senderOpenId>
npm run access -- group add <chatId> --no-mention
npm run access -- group add <chatId> --allow=<senderOpenId>
```

不要在飞书消息里执行配对批准；批准动作只应该在本机终端执行。

## 安全说明

`.env` 里有飞书密钥，不要提交。仓库已默认忽略：

```text
.env
data/
logs/
node_modules/
```

如果 `.env` 里启用了：

```env
CODEX_EXTRA_ARGS=--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
```

飞书发来的任务会以本机 Codex 权限执行。只把机器人加到可信群，并限制可用用户。

## 常见问题

群里不 `@` 没反应：

- 确认群已授权：`npm run access`
- 确认群策略是 `requireMention=false`
- 确认飞书应用有 `im:message.group_msg`
- 确认重新发布了应用版本
- 看日志是否出现 `message received`

查看服务状态：

```bash
npm run service-status
tail -f logs/bridge.log logs/launchd.err.log
```

停止后台服务：

```bash
npm run uninstall-service
```
