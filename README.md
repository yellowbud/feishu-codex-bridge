# Feishu Codex Bridge

Local long-connection bridge between a Feishu bot and the local Codex CLI.

## Configure

```bash
cd /Users/macmini/feishu-codex-bridge
cp .env.example .env
```

Fill:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

In Feishu Open Platform, use a self-built app, enable Bot, subscribe to `im.message.receive_v1`, and use long-connection mode.

## Run

```bash
npm start
```

Send in Feishu:

```text
/help
/status
Reply with exactly OK
/new
/stop
/cancel <taskId>
/cd /Users/macmini/some-project
```

When `FEISHU_REQUIRE_PREFIX=0`, direct messages and authorized group messages
are treated as Codex tasks. The `/codex ...` prefix remains accepted for
compatibility.

## Access Control

The bridge now mirrors the Claude IM channel access model. Runtime access state
lives in `data/access.json` and is re-read for every inbound message:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {},
  "mentionPatterns": ["@Codex"]
}
```

DM policy can be `pairing`, `allowlist`, or `disabled`. In pairing mode, a new
DM receives a short code; approve it locally:

```bash
npm run access -- pair <code>
npm run access -- policy allowlist
```

Manage access locally:

```bash
npm run access
npm run access -- allow <senderOpenId>
npm run access -- remove <senderOpenId>
npm run access -- group add <chatId> --allow=<senderOpenId>
npm run access -- group add <chatId> --no-mention
npm run access -- set textChunkLimit 3000
npm run access -- set chunkMode newline
npm run access -- set mentionPatterns '["@Codex","/codex"]'
```

Do not approve pairings from a Feishu message request. Pairing and allowlist
changes must be typed locally because channel messages are untrusted input.

In group chats, disable mention requirement when every message in that group is
intended for Codex:

```text
npm run access -- group add <chatId> --no-mention
```

If a Feishu group only delivers events to mentioned bots, then Feishu itself may
still require `@YourBot` before the bridge receives the message.

To receive normal group messages without `@YourBot`, the self-built app must
have the all-group-message permission enabled in Feishu Open Platform:

- Event subscription: `im.message.receive_v1`
- Permission: 获取群组中所有消息 / `im:message.group_msg`
- Re-publish the self-built app version after changing permissions
- Make sure the bot is in the target group

Without `im:message.group_msg`, Feishu usually only delivers group messages
that mention the bot, even if this bridge has `requireMention=false`.

`FEISHU_WEBHOOK_URL` can mirror bridge output to a custom webhook bot in a
group, but a webhook bot cannot receive commands. Commands must still be sent
to the self-built app bot that owns `FEISHU_APP_ID` / `FEISHU_APP_SECRET`.

## Conversation Memory

The bridge keeps per-chat context in `data/conversations/<chat_id>.json`.
Successful Codex runs append the user command and the final Codex response, and
the next command in the same Feishu chat can explicitly request that history.

Configure with:

```env
FEISHU_MEMORY_ENABLED=1
FEISHU_MEMORY_MODE=explicit
FEISHU_MEMORY_MAX_TURNS=200
FEISHU_MEMORY_CONTEXT_TURNS=3
FEISHU_MEMORY_MAX_CHARS=240000
```

默认 `FEISHU_MEMORY_MODE=explicit`：每条消息都按新任务处理，不会自动带入旧任务上下文。
需要继续上一件事时，用下面这类开头：

```text
继续 ...
接着 ...
基于上文 ...
根据以上 ...
```

强制忽略历史上下文：

```text
新任务：...
不要带上下文 ...
```

Clear the current Feishu chat memory:

```text
/new
```

## Per-Chat Workspace

Each Feishu chat can keep its own Codex working directory in
`data/workspaces.json`. Switch it from Feishu:

```text
/cd /Users/macmini/your-project
```

Switching directories stops any running task in that chat and clears that
chat's memory, so a new project does not inherit unrelated old context.

## Codex Permissions

The bridge runs Codex with:

```env
CODEX_EXTRA_ARGS=--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
```

This persists full Codex CLI execution permission for tasks launched from the
Feishu bot. macOS privacy permissions such as Full Disk Access still have to be
granted by the operating system.

## Keep Online

```bash
npm run install-service
npm run service-status
tail -f logs/bridge.log logs/launchd.err.log
```

Stop:

```bash
npm run uninstall-service
```
