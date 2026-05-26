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
6. 改权限后重新发布应用版本，并把机器人加入目标群。

如果没有 `im:message.group_msg`，飞书通常只会把 `@机器人` 的群消息投递给应用。

## 飞书里怎么用

私聊或已授权群里直接发需求：

```text
帮我检查这个项目
```

常用命令：

```text
/help
/status
/new
/stop
/cancel <taskId>
/cd /Users/macmini/some-project
```

说明：

- `/cd` 切换当前飞书会话的工作目录。
- 每个飞书会话都有自己的 Codex session，下一条消息默认接着聊。
- `/new` 清空当前飞书会话的 Codex session，开启全新任务。
- `/new <任务>` 开新 session 并立刻执行这个任务。
- `/cd` 会同时开启新 session，避免新项目串到旧项目。

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
