#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Lark = require('@larksuiteoapi/node-sdk');
const { HttpsProxyAgent } = require('https-proxy-agent');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const CONVERSATION_DIR = path.join(DATA_DIR, 'conversations');
const ATTACHMENT_DIR = path.join(DATA_DIR, 'attachments');
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspaces.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const APPROVED_DIR = path.join(DATA_DIR, 'approved');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CONVERSATION_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 });

const config = {
  appId: requireEnv('FEISHU_APP_ID'),
  appSecret: requireEnv('FEISHU_APP_SECRET'),
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || undefined,
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || undefined,
  commandPrefix: process.env.FEISHU_COMMAND_PREFIX || '/codex',
  requirePrefix: process.env.FEISHU_REQUIRE_PREFIX !== '0',
  allowedChatIds: splitList(process.env.FEISHU_ALLOWED_CHAT_IDS),
  accessEnabled: process.env.FEISHU_ACCESS_ENABLED !== '0',
  webhookUrl: process.env.FEISHU_WEBHOOK_URL || '',
  webhookMirror: process.env.FEISHU_WEBHOOK_MIRROR === '1',
  codexCwd: process.env.CODEX_CWD || process.env.HOME || process.cwd(),
  codexBin: process.env.CODEX_BIN || 'codex',
  codexModel: process.env.CODEX_MODEL || '',
  codexExtraArgs: splitArgs(process.env.CODEX_EXTRA_ARGS || '--skip-git-repo-check'),
  codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 30 * 60 * 1000),
  maxConcurrentTasks: Number(process.env.MAX_CONCURRENT_TASKS || 1),
  memoryEnabled: process.env.FEISHU_MEMORY_ENABLED !== '0',
  memoryMode: process.env.FEISHU_MEMORY_MODE || 'explicit',
  memoryMaxTurns: Number(process.env.FEISHU_MEMORY_MAX_TURNS || 200),
  memoryContextTurns: Number(process.env.FEISHU_MEMORY_CONTEXT_TURNS || 3),
  memoryMaxChars: Number(process.env.FEISHU_MEMORY_MAX_CHARS || 240000),
  codexSessionsEnabled: process.env.FEISHU_CODEX_SESSIONS_ENABLED !== '0',
  streamOutput: process.env.FEISHU_STREAM_OUTPUT === '1',
  newChatGroupMessageType: process.env.FEISHU_NEW_CHAT_GROUP_MESSAGE_TYPE || 'thread',
  outboundMediaEnabled: process.env.FEISHU_OUTBOUND_MEDIA_ENABLED !== '0',
  outboundMediaDirs: splitList(process.env.FEISHU_OUTBOUND_MEDIA_DIRS),
  feishuDocFolderToken: process.env.FEISHU_DOC_FOLDER_TOKEN || '',
  feishuDocBaseUrl: process.env.FEISHU_DOC_BASE_URL || 'https://www.feishu.cn/docx',
  codexReactionEmojis: splitList(process.env.FEISHU_CODEX_REACTION_EMOJIS || 'RobotFace,robot_face,ROBOT_FACE'),
  archivePrompts: process.env.FEISHU_ARCHIVE_PROMPTS !== '0',
  archivePromptMaxChars: Number(process.env.FEISHU_ARCHIVE_PROMPT_MAX_CHARS || 1800),
};

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

let client = createFeishuClient();
let wsClient = createFeishuWsClient();

const running = new Map();
const handledReactionEvents = new Set();
let taskSeq = 0;

function feishuClientConfig() {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  };
}

function createFeishuClient() {
  return new Lark.Client(feishuClientConfig());
}

function createFeishuWsClient() {
  return new Lark.WSClient({
    ...feishuClientConfig(),
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    handshakeTimeoutMs: 30000,
    source: 'feishu-codex-bridge',
    onReady: () => log('feishu websocket connected'),
    onReconnecting: () => log('feishu websocket reconnecting'),
    onReconnected: () => log('feishu websocket reconnected'),
    onError: (err) => log(`feishu websocket error: ${err.stack || err.message || err}`),
  });
}

const dispatcher = new Lark.EventDispatcher({
  encryptKey: config.encryptKey,
  verificationToken: config.verificationToken,
}).register({
  'im.message.receive_v1': (data) => {
    setImmediate(() => {
      handleIncomingMessage(data).catch((err) => {
        log(`message handler error: ${err.stack || err.message || err}`);
      });
    });
  },
  'card.action.trigger': (data) => {
    setImmediate(() => {
      handleCardAction(data).catch((err) => {
        log(`card action handler error: ${err.stack || err.message || err}`);
      });
    });
  },
  'im.message.reaction.created_v1': (data) => {
    setImmediate(() => {
      handleReactionCreated(data).catch((err) => {
        log(`reaction handler error: ${err.stack || err.message || err}`);
      });
    });
  },
});

main().catch((err) => {
  log(`fatal: ${err.stack || err.message || err}`);
  process.exit(1);
});

async function main() {
  log('starting feishu-codex-bridge');
  log(`codex cwd: ${config.codexCwd}`);
  log(`command prefix: ${config.commandPrefix} requirePrefix=${config.requirePrefix}`);
  log(`access control: ${config.accessEnabled ? `enabled (${ACCESS_FILE})` : 'disabled'}`);
  log(`webhook mirror: ${config.webhookUrl && config.webhookMirror ? 'enabled' : 'disabled'}`);
  log(`proxy: ${proxyUrl ? maskUrl(proxyUrl) : 'disabled'}`);
  if (config.accessEnabled) setInterval(checkApprovals, 5000).unref();
  await wsClient.start({ eventDispatcher: dispatcher });
}

async function handleIncomingMessage(data) {
  const message = data && data.message;
  if (!message) return;

  const chatId = message.chat_id;
  const messageId = message.message_id;
  const messageType = message.message_type;
  const chatType = message.chat_type;
  const context = messageContext(message);
  const text = extractText(message);
  const attachments = extractAttachments(message);
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const senderId = data.sender && data.sender.sender_id && (data.sender.sender_id.open_id || data.sender.sender_id.user_id);

  if (!chatId || !messageId || !senderId) return;
  if (!text && !attachments.length) return;
  log(`message received chat=${chatId} context=${context.contextId} type=${chatType || 'unknown'} messageType=${messageType || 'unknown'} sender=${senderId} mentions=${mentions.length} attachments=${attachments.length} text=${redactSensitiveCommand(text)}`);
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(chatId)) {
    log(`ignored message from unauthorized chat ${chatId}`);
    return;
  }

  const gateResult = gateMessage({ chatId, senderId, chatType, text, mentions });
  if (gateResult.action === 'drop') {
    log(`access drop chat=${chatId} sender=${senderId} type=${chatType || 'unknown'}`);
    return;
  }
  if (gateResult.action === 'pair') {
    await sendUiMessage(
      chatId,
      {
        kind: 'access',
        title: gateResult.isResend ? '配对码仍然有效' : '需要配对',
        template: 'orange',
        summary: `${gateResult.isResend ? '配对码仍然是' : '配对码'}：${gateResult.code}`,
        body: `请在本机执行：\n\`\`\`\nnpm run access -- pair ${gateResult.code}\n\`\`\``,
      },
      messageId,
    );
    return;
  }

  if (attachments.length) {
    await handleAttachmentMessage({
      chatId,
      messageId,
      senderId,
      context,
      text,
      message,
      attachments,
    });
    return;
  }

  if (messageType !== 'text') {
    await sendUiMessage(chatId, {
      kind: 'error',
      title: '不支持的消息类型',
      template: 'red',
      summary: `当前消息类型：${messageType || 'unknown'}`,
      body: '目前支持文本、图片和文件消息。',
    }, messageId);
    return;
  }

  const command = parseCommand(text);
  if (!command) return;

  if (command.kind === 'run') {
    await startCodexTask(command.prompt, {
      chatId,
      messageId,
      senderId,
      contextId: context.contextId,
      contextLabel: context.label,
      useMemory: command.useMemory,
      memoryReason: command.memoryReason,
      resetSession: command.resetSession,
    });
    return;
  }
  await runCommand(command, { chatId, messageId, senderId, context });
}

async function handleCardAction(data) {
  const evt = typeof Lark.normalizeCardAction === 'function'
    ? Lark.normalizeCardAction(data)
    : normalizeRawCardAction(data);
  if (!evt) return;
  const value = evt.action && evt.action.value && typeof evt.action.value === 'object' ? evt.action.value : {};
  if (value.kind === 'bridge_config') {
    await handleConfigAction(evt, value);
    return;
  }
  if (value.kind === 'bridge_resume') {
    await handleResumeAction(evt, value);
    return;
  }
  if (value.kind === 'bridge_workspace') {
    await handleWorkspaceAction(evt, value);
    return;
  }
  if (value.kind !== 'codex_prompt' || !value.prompt) {
    log(`ignored card action message=${evt.messageId || 'unknown'} action=${JSON.stringify(value).slice(0, 500)}`);
    return;
  }
  const chatId = value.chatId || evt.chatId;
  const contextId = value.contextId || chatId;
  if (!chatId) return;
  await sendUiMessage(chatId, {
    kind: 'status',
    title: '已选择',
    template: 'blue',
    summary: String(value.label || value.prompt).slice(0, 300),
  }, evt.messageId);
  await startCodexTask(String(value.prompt), {
    chatId,
    messageId: evt.messageId,
    senderId: evt.operator && (evt.operator.openId || evt.operator.userId) || 'card-action',
    contextId,
    contextLabel: value.contextLabel || 'card action',
    useMemory: true,
    memoryReason: 'card-action',
    resetSession: false,
  });
}

async function handleConfigAction(evt, value) {
  const chatId = value.chatId || evt.chatId;
  if (!chatId) return;
  const operatorId = evt.operator && (evt.operator.openId || evt.operator.userId) || 'card-action';
  const gateResult = gateAction({ chatId, senderId: operatorId, chatType: value.chatType || 'group' });
  if (gateResult.action !== 'deliver') {
    log(`config access drop chat=${chatId} sender=${operatorId}`);
    return;
  }
  const action = String(value.action || '');
  if (action === 'set') {
    updateChatPreference(chatId, value.key, value.value);
  } else if (action === 'max_delta') {
    updateGlobalPreference('maxConcurrentTasks', clampInt(effectiveMaxConcurrentTasks() + Number(value.delta || 0), 1, 10));
  }
  await sendConfigForm(chatId, evt.messageId, {
    title: '偏好设置已更新',
    template: 'green',
  });
}

async function handleResumeAction(evt, value) {
  const chatId = value.chatId || evt.chatId;
  if (!chatId || !value.sessionId) return;
  const operatorId = evt.operator && (evt.operator.openId || evt.operator.userId) || 'card-action';
  const gateResult = gateAction({ chatId, senderId: operatorId, chatType: value.chatType || 'group' });
  if (gateResult.action !== 'deliver') {
    log(`resume access drop chat=${chatId} sender=${operatorId}`);
    return;
  }
  const contextId = value.contextId || chatId;
  const workspaceName = normalizeWorkspaceName(value.workspaceName) || workspaceForChat(projectChatId(contextId)).name;
  const cwd = value.cwd || workspaceForChat(projectChatId(contextId)).cwd;
  setNamedWorkspace(projectChatId(contextId), workspaceName, cwd, true);
  setChatSession(contextId, String(value.sessionId), cwd, value.taskId || 'manual-resume', workspaceName);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: '会话已恢复',
    template: 'green',
    summary: [
      `**Workspace**：${workspaceName}`,
      `**工作目录**：${cwd}`,
      `**Codex session**：${value.sessionId}`,
    ].join('\n'),
    body: '下一条消息会接着这个 Codex session 运行。',
  }, evt.messageId);
}

async function handleWorkspaceAction(evt, value) {
  const chatId = value.chatId || evt.chatId;
  if (!chatId || value.action !== 'use') return;
  const operatorId = evt.operator && (evt.operator.openId || evt.operator.userId) || 'card-action';
  const gateResult = gateAction({ chatId, senderId: operatorId, chatType: value.chatType || 'group' });
  if (gateResult.action !== 'deliver') {
    log(`workspace action access drop chat=${chatId} sender=${operatorId}`);
    return;
  }
  await switchWorkspace(chatId, value.name, evt.messageId);
}

async function handleReactionCreated(data) {
  const emoji = data && data.reaction_type && data.reaction_type.emoji_type;
  const messageId = data && data.message_id;
  const operatorId = data && data.user_id && (data.user_id.open_id || data.user_id.user_id);
  const dedupeKey = `${data && (data.event_id || data.uuid || '')}:${messageId}:${operatorId}:${emoji}`;
  if (!messageId || !operatorId || !emoji) return;
  if (handledReactionEvents.has(dedupeKey)) return;
  rememberReactionEvent(dedupeKey);

  if (!config.codexReactionEmojis.includes(emoji)) {
    log(`ignored reaction emoji=${emoji} message=${messageId}`);
    return;
  }

  const message = await fetchMessage(messageId);
  if (!message || message.deleted) {
    log(`reaction target message unavailable message=${messageId}`);
    return;
  }
  const chatId = message.chat_id;
  if (!chatId) return;
  if (config.allowedChatIds.length && !config.allowedChatIds.includes(chatId)) {
    log(`ignored reaction from unauthorized chat ${chatId}`);
    return;
  }
  const gateResult = gateAction({ chatId, senderId: operatorId, chatType: message.chat_type || 'group' });
  if (gateResult.action !== 'deliver') {
    log(`reaction access drop chat=${chatId} sender=${operatorId} emoji=${emoji}`);
    return;
  }

  const context = messageContext(message);
  const text = extractText(message);
  const attachments = extractAttachments(message);
  log(`reaction forwarded message=${messageId} chat=${chatId} context=${context.contextId} sender=${operatorId} emoji=${emoji} attachments=${attachments.length} text=${singleLine(text).slice(0, 120)}`);

  if (!text && !attachments.length) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '这条消息无法转给 Codex',
      template: 'orange',
      summary: '没有读取到文本、图片或文件内容。',
    }, messageId);
    return;
  }

  if (attachments.length) {
    await handleAttachmentMessage({
      chatId,
      messageId,
      senderId: operatorId,
      context,
      text: buildForwardedMessagePrompt(message, text, ''),
      message,
      attachments,
    });
    return;
  }

  const prompt = buildForwardedMessagePrompt(message, text, '请处理这条飞书消息，并直接给出结果。');
  await startCodexTask(prompt, {
    chatId,
    messageId,
    senderId: operatorId,
    contextId: context.contextId,
    contextLabel: context.label,
    useMemory: true,
    memoryReason: 'reaction-forward',
    resetSession: false,
  });
}

function rememberReactionEvent(key) {
  handledReactionEvents.add(key);
  if (handledReactionEvents.size > 500) {
    const [first] = handledReactionEvents;
    handledReactionEvents.delete(first);
  }
}

async function fetchMessage(messageId) {
  const response = await client.im.message.get({
    path: { message_id: messageId },
    params: { user_id_type: 'open_id' },
  });
  const item = response && response.data && Array.isArray(response.data.items) ? response.data.items[0] : null;
  if (!item) return null;
  return {
    message_id: item.message_id || messageId,
    root_id: item.root_id,
    parent_id: item.parent_id,
    thread_id: item.thread_id,
    chat_id: item.chat_id,
    chat_type: item.chat_type || 'group',
    message_type: item.msg_type,
    content: item.body && item.body.content || '{}',
    mentions: item.mentions || [],
    deleted: item.deleted,
    sender: item.sender,
    message_app_link: item.message_app_link,
  };
}

function buildForwardedMessagePrompt(message, text, instruction) {
  const sender = message.sender && (message.sender.sender_name || message.sender.id) || 'unknown';
  const lines = [
    '用户在飞书里一键转发了下面这条消息给 Codex。',
    instruction ? `用户意图：${instruction}` : null,
    '',
    `原消息发送者：${sender}`,
    message.message_app_link ? `原消息链接：${message.message_app_link}` : null,
    '',
    '原消息内容：',
    String(text || '').trim() || '(无文本内容)',
  ].filter(Boolean);
  return lines.join('\n');
}

function normalizeRawCardAction(data) {
  const action = data && data.action || {};
  const context = data && data.context || {};
  const operator = data && data.operator || {};
  return {
    messageId: context.open_message_id || data.open_message_id,
    chatId: context.open_chat_id || data.open_chat_id,
    operator: {
      openId: operator.open_id || data.open_id,
      userId: operator.user_id || data.user_id,
      name: operator.name,
    },
    action: {
      value: action.value || {},
      tag: action.tag,
      option: action.option,
    },
  };
}

async function handleAttachmentMessage(input) {
  let files;
  try {
    files = await downloadMessageAttachments(input.message, input.attachments);
  } catch (err) {
    await sendUiMessage(input.chatId, {
      kind: 'error',
      title: '附件下载失败',
      template: 'red',
      summary: formatApiError(err),
      body: '请确认飞书应用已开通“获取消息中的资源文件”权限，并重新发布自建应用版本。',
    }, input.messageId);
    log(`attachment download failed chat=${input.chatId} message=${input.messageId}: ${err.stack || err.message || err}`);
    return;
  }

  if (!files.length) {
    await sendUiMessage(input.chatId, {
      kind: 'warn',
      title: '没有可读取的附件',
      template: 'orange',
      summary: '这条消息里没有找到图片或文件资源。',
    }, input.messageId);
    return;
  }

  const rawText = stripMention(input.text || '').trim();
  const parsed = rawText ? parseCommand(rawText) : null;
  if (parsed && parsed.kind !== 'run') {
    await runCommand(parsed, {
      chatId: input.chatId,
      messageId: input.messageId,
      senderId: input.senderId,
      context: input.context,
    });
    return;
  }

  const fallback = '请读取我刚发送的附件，并根据附件内容直接回复。';
  const promptText = parsed && parsed.kind === 'run'
    ? parsed.prompt
    : rawText || fallback;
  const prompt = buildAttachmentPrompt(promptText, files);
  const memoryHint = rawText ? memoryHintForPrompt(promptText) : {
    useMemory: false,
    resetSession: false,
    reason: 'attachment-new-task',
  };

  await startCodexTask(prompt, {
    chatId: input.chatId,
    messageId: input.messageId,
    senderId: input.senderId,
    contextId: input.context && input.context.contextId,
    contextLabel: input.context && input.context.label,
    useMemory: parsed && parsed.kind === 'run' ? parsed.useMemory : memoryHint.useMemory,
    memoryReason: parsed && parsed.kind === 'run' ? parsed.memoryReason : memoryHint.reason,
    resetSession: parsed && parsed.kind === 'run' ? parsed.resetSession : memoryHint.resetSession,
  });
}

async function runCommand(command, source) {
  if (!command) return;
  const { chatId, messageId, senderId, context } = source;
  const contextId = context && context.contextId ? context.contextId : chatId;
  if (command.kind === 'help') {
    await sendHelp(chatId, messageId);
    return;
  }
  if (command.kind === 'status') {
    await sendStatus(chatId, messageId, contextId, context && context.label);
    return;
  }
  if (command.kind === 'config') {
    await sendConfigForm(chatId, messageId, { isGroup: context && isGroupChat(context.chatType) });
    return;
  }
  if (command.kind === 'timeout') {
    await handleTimeoutCommand(command, { chatId, messageId, contextId });
    return;
  }
  if (command.kind === 'account') {
    await handleAccountCommand(command, { chatId, messageId });
    return;
  }
  if (command.kind === 'resume') {
    await sendResumePicker(chatId, messageId, contextId, command.limit);
    return;
  }
  if (command.kind === 'reset') {
    resetConversation(contextId);
    clearChatSession(contextId);
    await sendUiMessage(chatId, {
      kind: 'success',
      title: '新会话已开始',
      template: 'green',
      summary: `${context && context.label ? context.label : '当前会话'}的 Codex session 和上下文记忆已重置。`,
    }, messageId);
    return;
  }
  if (command.kind === 'newChat') {
    await createManagedChat(command.topic, { chatId, messageId, senderId });
    return;
  }
  if (command.kind === 'cd') {
    await handleCd(chatId, command.target, messageId, contextId);
    return;
  }
  if (command.kind === 'ws') {
    await handleWorkspaceCommand(chatId, command.args, messageId);
    return;
  }
  if (command.kind === 'stop') {
    await cancelChatTasks(chatId, messageId, { contextId });
    return;
  }
  if (command.kind === 'cancel') {
    await cancelTask(command.taskId, chatId, messageId);
  }
}

function parseCommand(rawText) {
  const text = stripMention(rawText).trim();
  const prefix = config.commandPrefix;

  if (config.requirePrefix && !text.startsWith(prefix)) return null;

  let body = config.requirePrefix ? text.slice(prefix.length).trim() : text;
  const wasPrefixed = config.requirePrefix || (!config.requirePrefix && body.startsWith(prefix));
  if (!config.requirePrefix && body.startsWith(prefix)) body = body.slice(prefix.length).trim();
  const isSlashCommand = body.startsWith('/');
  const commandBody = isSlashCommand ? body.slice(1).trim() : body;
  const [commandName = '', ...commandArgs] = commandBody.split(/\s+/);
  const commandLower = commandName.toLowerCase();
  const exactCommand = commandArgs.length === 0;
  const commandWithArgsAllowed = isSlashCommand || wasPrefixed;

  if (!body || (exactCommand && ['help', '帮助'].includes(commandLower))) return { kind: 'help' };
  if (exactCommand && ['status', '状态'].includes(commandLower)) return { kind: 'status' };
  if (exactCommand && ['config', 'settings', '设置', '偏好设置'].includes(commandLower)) return { kind: 'config' };
  if (commandWithArgsAllowed && commandLower === 'timeout') return { kind: 'timeout', value: commandArgs.join(' ').trim() };
  if (commandWithArgsAllowed && commandLower === 'account') return { kind: 'account', args: commandArgs };
  if (commandWithArgsAllowed && ['resume', '恢复'].includes(commandLower)) return { kind: 'resume', limit: clampInt(commandArgs[0] || 5, 1, 10) };
  if (commandWithArgsAllowed && commandLower === 'new' && (commandArgs[0] || '').toLowerCase() === 'chat') {
    return { kind: 'newChat', topic: commandArgs.slice(1).join(' ').trim() };
  }
  if (exactCommand && ['new', 'reset', 'clear', 'forget', '清空上下文', '清空记忆', '忘记'].includes(commandLower)) {
    return { kind: 'reset' };
  }
  if (commandWithArgsAllowed && ['new', 'reset', 'clear', 'forget'].includes(commandLower)) {
    const prompt = commandArgs.join(' ').trim();
    if (prompt) return { kind: 'run', prompt, useMemory: false, resetSession: true, memoryReason: 'slash-new' };
  }
  if (exactCommand && ['stop', '停止', '中止'].includes(commandLower)) {
    return { kind: 'stop' };
  }
  if (commandWithArgsAllowed && ['cancel', '取消'].includes(commandLower)) {
    const [taskId] = commandArgs;
    return { kind: 'cancel', taskId };
  }
  if (commandWithArgsAllowed && commandLower === 'cd') return { kind: 'cd', target: commandArgs.join(' ') };
  if (commandWithArgsAllowed && commandLower === 'ws') return { kind: 'ws', args: commandArgs };

  const memoryHint = memoryHintForPrompt(body);
  return {
    kind: 'run',
    prompt: memoryHint.prompt,
    useMemory: memoryHint.useMemory,
    resetSession: memoryHint.resetSession,
    memoryReason: memoryHint.reason,
  };
}

function memoryHintForPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return { prompt: text, useMemory: false, reason: 'empty' };

  const forceNew = text.match(/^(新任务|新的任务|开始新任务|另起一个任务|不要带上下文|不带上下文|忽略上文|忘记上文)[:：\s]+(.+)$/s);
  if (forceNew) return { prompt: forceNew[2].trim(), useMemory: false, resetSession: true, reason: 'force-new' };

  const forceContinue = text.match(/^(继续|接着|基于上文|基于以上|根据上文|根据以上|参考上文|参考以上|延续上文|延续以上)[:：\s]*(.*)$/s);
  if (forceContinue) {
    const cleaned = forceContinue[2].trim();
    return { prompt: cleaned || text, useMemory: true, resetSession: false, reason: forceContinue[1] };
  }

  return {
    prompt: text,
    useMemory: config.memoryMode === 'always',
    resetSession: false,
    reason: config.memoryMode === 'always' ? 'always' : 'new-task-default',
  };
}

function defaultAccess() {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  };
}

function readAccessFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
    return {
      dmPolicy: ['pairing', 'allowlist', 'disabled'].includes(parsed.dmPolicy) ? parsed.dmPolicy : 'pairing',
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      preferences: parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {},
      chatPreferences: parsed.chatPreferences && typeof parsed.chatPreferences === 'object' ? parsed.chatPreferences : {},
      mentionPatterns: Array.isArray(parsed.mentionPatterns) ? parsed.mentionPatterns : undefined,
      textChunkLimit: Number.isFinite(parsed.textChunkLimit) ? parsed.textChunkLimit : undefined,
      chunkMode: ['length', 'newline'].includes(parsed.chunkMode) ? parsed.chunkMode : undefined,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultAccess();
    try {
      fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`);
    } catch {}
    log('access.json is corrupt, moved aside. Starting fresh.');
    return defaultAccess();
  }
}

async function createManagedChat(topic, source) {
  const title = chatTitle(topic);
  try {
    const response = await client.im.chat.create({
      params: {
        user_id_type: 'open_id',
        uuid: `new-chat-${Date.now()}-${randomBytes(4).toString('hex')}`,
      },
      data: {
        name: title,
        description: '由 Feishu Codex Bridge 自动创建。一个群代表一个 project，群内每个 thread/topic 代表一个独立 Codex session。',
        user_id_list: source.senderId ? [source.senderId] : [],
        group_message_type: config.newChatGroupMessageType === 'chat' ? 'chat' : 'thread',
        chat_type: 'private',
      },
    });
    const newChatId = response && response.data && response.data.chat_id;
    if (!newChatId) throw new Error(`create chat returned no chat_id: ${JSON.stringify(response).slice(0, 1000)}`);

    allowManagedGroup(newChatId, source.senderId);
    const inheritedWorkspace = workspaceForChat(source.chatId);
    setNamedWorkspace(newChatId, inheritedWorkspace.name, inheritedWorkspace.cwd, true);
    await sendUiMessage(source.chatId, {
      kind: 'success',
      title: '新群聊已创建',
      template: 'green',
      summary: `**${title}**\nchat_id: ${newChatId}`,
      body: `机器人已把你拉入新群，并继承当前工作目录：\`${inheritedWorkspace.cwd}\`。后续在新群里直接发消息即可；每个话题/thread 会保留自己的 Codex session。`,
    }, source.messageId);
    await sendUiMessage(newChatId, {
      kind: 'success',
      title: title,
      template: 'blue',
      summary: '这个群就是一个 project。',
      body: [
        `已继承工作目录：\`${inheritedWorkspace.cwd}\`。直接在群里发需求即可开始任务。`,
        '在话题群里每个话题是独立 session；普通群里每个消息 thread 是独立 session。',
        '可用 `/cd <目录>` 绑定项目目录，或 `/ws save <名字>` 保存当前 workspace。',
      ].join('\n'),
    });
    log(`created managed chat chat=${newChatId} owner=${source.senderId || 'unknown'} title=${title}`);
  } catch (err) {
    await sendUiMessage(source.chatId, {
      kind: 'error',
      title: '创建群聊失败',
      template: 'red',
      summary: formatApiError(err),
      body: '请确认飞书应用有创建群、拉用户入群相关权限，并已重新发布自建应用版本。',
    }, source.messageId);
    log(`create managed chat failed sender=${source.senderId || 'unknown'}: ${err.stack || err.message || err}`);
  }
}

function chatTitle(topic) {
  const cleaned = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `Codex Project ${new Date().toISOString().slice(0, 10)}`;
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
}

function allowManagedGroup(chatId, senderId) {
  if (!config.accessEnabled || !chatId) return;
  const access = readAccessFile();
  access.groups = access.groups && typeof access.groups === 'object' ? access.groups : {};
  const existing = access.groups[chatId] && typeof access.groups[chatId] === 'object' ? access.groups[chatId] : {};
  const allowFrom = Array.isArray(existing.allowFrom) ? existing.allowFrom.slice() : [];
  if (senderId && !allowFrom.includes(senderId)) allowFrom.push(senderId);
  access.groups[chatId] = {
    ...existing,
    requireMention: false,
    allowFrom,
    createdBy: existing.createdBy || senderId,
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  saveAccess(access);
}

async function handleWorkspaceCommand(chatId, args, replyToMessageId) {
  const [rawAction = '', ...rest] = args;
  const action = rawAction.toLowerCase();

  if (!rawAction || ['list', 'ls', 'status', 'current'].includes(action)) {
    await sendWorkspaceStatus(chatId, replyToMessageId);
    return;
  }

  if (action === 'save') {
    await saveCurrentWorkspace(chatId, rest[0], replyToMessageId);
    return;
  }

  if (['add', 'set'].includes(action)) {
    const [name, ...pathParts] = rest;
    await addWorkspace(chatId, name, pathParts.join(' '), replyToMessageId);
    return;
  }

  if (['use', 'switch'].includes(action)) {
    await switchWorkspace(chatId, rest[0], replyToMessageId);
    return;
  }

  if (['remove', 'rm', 'delete', 'del'].includes(action)) {
    await removeWorkspace(chatId, rest[0], replyToMessageId);
    return;
  }

  if (rest.length) {
    await addWorkspace(chatId, rawAction, rest.join(' '), replyToMessageId);
    return;
  }

  await switchWorkspace(chatId, rawAction, replyToMessageId);
}

async function addWorkspace(chatId, name, target, replyToMessageId) {
  const workspaceName = normalizeWorkspaceName(name);
  if (!workspaceName) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '缺少 workspace 名称',
      template: 'orange',
      summary: '示例：`/ws add bridge /Users/macmini/feishu-codex-bridge`',
    }, replyToMessageId);
    return;
  }

  const resolved = resolveWorkspacePath(target, cwdForChat(chatId));
  if (!resolved.ok) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: 'Workspace 未添加',
      template: 'orange',
      summary: resolved.message,
      body: '示例：`/ws add bridge /Users/macmini/feishu-codex-bridge`',
    }, replyToMessageId);
    return;
  }

  await cancelChatTasks(chatId, replyToMessageId, { quietWhenEmpty: true });
  setNamedWorkspace(chatId, workspaceName, resolved.path, true);
  clearChatSession(chatId, workspaceName);
  resetConversation(chatId, workspaceName);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: 'Workspace 已切换',
    template: 'green',
    summary: `**${workspaceName}**\n${resolved.path}`,
    body: `以后可用 \`/ws ${workspaceName}\` 切回；该 workspace 会保留自己的 Codex session。`,
  }, replyToMessageId);
}

async function saveCurrentWorkspace(chatId, name, replyToMessageId) {
  const workspaceName = normalizeWorkspaceName(name);
  if (!workspaceName) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '缺少 workspace 名称',
      template: 'orange',
      summary: '示例：`/ws save bridge`',
    }, replyToMessageId);
    return;
  }
  const current = workspaceForChat(chatId);
  setNamedWorkspace(chatId, workspaceName, current.cwd, true);
  clearChatSession(chatId, workspaceName);
  resetConversation(chatId, workspaceName);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: 'Workspace 已保存',
    template: 'green',
    summary: `**${workspaceName}**\n${current.cwd}`,
    body: `以后可用 \`/ws use ${workspaceName}\` 切回；已为该 workspace 开启新 session。`,
  }, replyToMessageId);
}

async function switchWorkspace(chatId, name, replyToMessageId) {
  const workspaceName = normalizeWorkspaceName(name);
  if (!workspaceName) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '缺少 workspace 名称',
      template: 'orange',
      summary: '示例：`/ws bridge`',
    }, replyToMessageId);
    return;
  }

  const workspace = namedWorkspaceForChat(chatId, workspaceName);
  if (!workspace) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '未找到 workspace',
      template: 'orange',
      summary: workspaceName,
      body: '先添加：`/ws add <name> <目录>`',
    }, replyToMessageId);
    return;
  }

  await cancelChatTasks(chatId, replyToMessageId, { quietWhenEmpty: true });
  setCurrentWorkspace(chatId, workspaceName);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: 'Workspace 已切换',
    template: 'green',
    summary: `**${workspaceName}**\n${workspace.cwd}`,
    body: `Codex session：${sessionForChat(chatId) || '未创建'}`,
  }, replyToMessageId);
}

async function removeWorkspace(chatId, name, replyToMessageId) {
  const workspaceName = normalizeWorkspaceName(name);
  if (!workspaceName || workspaceName === 'default') {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '不能删除该 workspace',
      template: 'orange',
      summary: workspaceName || '缺少名称',
    }, replyToMessageId);
    return;
  }

  const removed = deleteNamedWorkspace(chatId, workspaceName);
  if (removed) clearChatSession(chatId, workspaceName);
  await sendUiMessage(chatId, {
    kind: removed ? 'success' : 'warn',
    title: removed ? 'Workspace 已删除' : '未找到 workspace',
    template: removed ? 'green' : 'orange',
    summary: workspaceName,
  }, replyToMessageId);
}

async function sendWorkspaceStatus(chatId, replyToMessageId) {
  const state = workspaceStateForChat(chatId);
  const current = state.current;
  const entries = Object.entries(state.items).sort(([a], [b]) => a.localeCompare(b));
  const lines = entries.map(([name, workspace]) => `${name === current ? '•' : '-'} **${escapeMarkdownLine(name)}**：${workspace.cwd}`);
  const isGroup = Boolean(readAccessFile().groups[chatId]);
  await sendCard(chatId, {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Workspaces' },
    },
    elements: cardElements([
      { tag: 'markdown', content: `当前：**${escapeMarkdownLine(current)}**\n\n${lines.join('\n') || '暂无 workspace。'}` },
      ...entries.map(([name]) => ({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: name === current ? `✓ ${name}` : `使用 ${name}` },
          type: name === current ? 'primary' : 'default',
          value: {
            kind: 'bridge_workspace',
            action: 'use',
            chatId,
            chatType: isGroup ? 'group' : 'p2p',
            name,
          },
        }],
      })),
    ]),
  }, `Workspaces\n当前：${current}\n${lines.join('\n')}`, replyToMessageId, { forceCard: true });
}

async function sendConfigForm(chatId, replyToMessageId, options = {}) {
  const prefs = effectiveChatPreferences(chatId);
  const maxConcurrentTasks = effectiveMaxConcurrentTasks();
  const isGroup = typeof options.isGroup === 'boolean' ? options.isGroup : Boolean(readAccessFile().groups[chatId]);
  const requireMention = prefs.requireMention;
  const summary = [
    `**消息回复方式**：${prefs.replyMode === 'text' ? '纯文本' : '卡片'}`,
    `**工具调用显示**：${prefs.showToolCalls ? '显示' : '隐藏'}`,
    `**并发上限**：${maxConcurrentTasks}`,
    `**全局 run 探活**：${timeoutStatusText({ mode: 'global', ms: effectiveGlobalRunTimeoutMs() })}`,
    `**群内 @ bot 才回复**：${requireMention ? '需要' : '不需要'}`,
  ].join('\n');
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: options.template || 'blue',
      title: { tag: 'plain_text', content: options.title || '偏好设置' },
    },
    elements: cardElements([
      { tag: 'markdown', content: `${summary}\n\n点击下面按钮会立即生效。` },
      {
        tag: 'action',
        layout: 'flow',
        actions: [
          configButton('卡片回复', chatId, isGroup, 'replyMode', 'card', prefs.replyMode === 'card'),
          configButton('纯文本回复', chatId, isGroup, 'replyMode', 'text', prefs.replyMode === 'text'),
        ],
      },
      {
        tag: 'action',
        layout: 'flow',
        actions: [
          configButton('显示工具调用', chatId, isGroup, 'showToolCalls', true, prefs.showToolCalls),
          configButton('隐藏工具调用', chatId, isGroup, 'showToolCalls', false, !prefs.showToolCalls),
        ],
      },
      {
        tag: 'action',
        layout: 'flow',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '并发 -1' },
            type: 'default',
            value: { kind: 'bridge_config', action: 'max_delta', chatId, chatType: isGroup ? 'group' : 'p2p', delta: -1 },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '并发 +1' },
            type: 'primary',
            value: { kind: 'bridge_config', action: 'max_delta', chatId, chatType: isGroup ? 'group' : 'p2p', delta: 1 },
          },
        ],
      },
      isGroup ? {
        tag: 'action',
        layout: 'flow',
        actions: [
          configButton('群内需要 @', chatId, isGroup, 'requireMention', true, requireMention),
          configButton('群内直接回复', chatId, isGroup, 'requireMention', false, !requireMention),
        ],
      } : { tag: 'markdown', content: '当前是私聊，群内 @ 设置只在群聊里显示并生效。' },
    ]),
  };
  await sendCard(chatId, card, `偏好设置\n${summary}`, replyToMessageId, { forceCard: true });
}

async function handleTimeoutCommand(command, source) {
  const workspace = workspaceForChat(projectChatId(source.contextId));
  const raw = String(command.value || '').trim().toLowerCase();
  if (!raw) {
    const status = effectiveRunTimeout(source.contextId, workspace.name);
    await sendUiMessage(source.chatId, {
      kind: 'status',
      title: '当前 session 探活',
      template: 'blue',
      summary: timeoutStatusText(status),
      body: [
        '`/timeout 15` 设置当前 session 15 分钟无响应自动 kill',
        '`/timeout off` 当前 session 关闭探活',
        '`/timeout default` 清掉当前 session 覆盖，跟随全局',
      ].join('\n'),
    }, source.messageId);
    return;
  }
  if (raw === 'off') {
    setSessionTimeoutOverride(source.contextId, workspace.name, 'off');
  } else if (raw === 'default') {
    clearSessionTimeoutOverride(source.contextId, workspace.name);
  } else {
    const minutes = Number.parseFloat(raw);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      await sendUiMessage(source.chatId, {
        kind: 'warn',
        title: '探活设置无效',
        template: 'orange',
        summary: '请输入 1 到 1440 之间的分钟数，或 off/default。',
      }, source.messageId);
      return;
    }
    setSessionTimeoutOverride(source.contextId, workspace.name, Math.round(minutes * 60 * 1000));
  }
  await sendUiMessage(source.chatId, {
    kind: 'success',
    title: '探活设置已更新',
    template: 'green',
    summary: timeoutStatusText(effectiveRunTimeout(source.contextId, workspace.name)),
  }, source.messageId);
}

async function handleAccountCommand(command, source) {
  const [action = '', appId = '', appSecret = ''] = command.args || [];
  if (!action) {
    await sendUiMessage(source.chatId, {
      kind: 'status',
      title: '当前 Feishu 应用',
      template: 'blue',
      summary: [
        `**appId**：${maskSecret(config.appId, 8, 4)}`,
        `**appSecret**：${maskSecret(config.appSecret, 4, 4)}`,
        `**连接状态**：运行中`,
      ].join('\n'),
      body: '`/account change <appId> <appSecret>` 更新应用凭据并热重连。',
    }, source.messageId);
    return;
  }
  if (action.toLowerCase() !== 'change') {
    await sendUiMessage(source.chatId, {
      kind: 'warn',
      title: '不支持的 account 命令',
      template: 'orange',
      summary: '`/account` 或 `/account change <appId> <appSecret>`',
    }, source.messageId);
    return;
  }
  if (!appId || !appSecret) {
    await sendUiMessage(source.chatId, {
      kind: 'warn',
      title: '缺少应用凭据',
      template: 'orange',
      summary: '`/account change <appId> <appSecret>`',
      body: '建议在私聊里执行，避免 secret 留在群消息里。',
    }, source.messageId);
    return;
  }
  try {
    updateEnvFile({ FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret });
    config.appId = appId;
    config.appSecret = appSecret;
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = appSecret;
    await reconnectFeishu();
    await sendUiMessage(source.chatId, {
      kind: 'success',
      title: '应用已切换',
      template: 'green',
      summary: `appId：${maskSecret(config.appId, 8, 4)}\n已热重连 Feishu 长连接。`,
    }, source.messageId);
  } catch (err) {
    await sendUiMessage(source.chatId, {
      kind: 'error',
      title: '应用切换失败',
      template: 'red',
      summary: formatApiError(err),
    }, source.messageId);
    log(`account change failed: ${err.stack || err.message || err}`);
  }
}

async function sendResumePicker(chatId, replyToMessageId, contextId, limit = 5) {
  const sessions = recentSessionsForProject(chatId, limit);
  const isGroup = Boolean(readAccessFile().groups[chatId]);
  if (!sessions.length) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '没有可恢复的历史会话',
      template: 'orange',
      summary: '当前 project 还没有记录到 Codex session。',
    }, replyToMessageId);
    return;
  }
  const rows = sessions.map((session, index) => {
    const when = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
    return `${index + 1}. **${escapeMarkdownLine(session.workspaceName)}** · ${escapeMarkdownLine(session.label)}\n${when}\n${session.cwd}`;
  });
  await sendCard(chatId, {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '恢复历史会话' },
    },
    elements: cardElements([
      { tag: 'markdown', content: rows.join('\n\n') },
      ...sessions.map((session, index) => ({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: `恢复 ${index + 1}` },
          type: index === 0 ? 'primary' : 'default',
          value: {
            kind: 'bridge_resume',
            chatId,
            chatType: isGroup ? 'group' : 'p2p',
            contextId,
            sessionId: session.sessionId,
            workspaceName: session.workspaceName,
            cwd: session.cwd,
            taskId: session.taskId,
          },
        }],
      })),
    ]),
  }, `恢复历史会话\n${rows.join('\n\n')}`, replyToMessageId, { forceCard: true });
}

function configButton(label, chatId, isGroup, key, value, selected) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: selected ? `✓ ${label}` : label },
    type: selected ? 'primary' : 'default',
    value: {
      kind: 'bridge_config',
      action: 'set',
      chatId,
      chatType: isGroup ? 'group' : 'p2p',
      key,
      value,
    },
  };
}

async function handleCd(chatId, target, replyToMessageId, contextId = chatId) {
  const resolved = resolveWorkspacePath(target, cwdForChat(chatId));
  if (!resolved.ok) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '工作目录未切换',
      template: 'orange',
      summary: resolved.message,
      body: '示例：`/cd /Users/macmini/your-project`',
    }, replyToMessageId);
    return;
  }

  await cancelChatTasks(chatId, replyToMessageId, { quietWhenEmpty: true });
  setChatCwd(chatId, resolved.path);
  clearProjectSessions(chatId);
  resetProjectConversations(chatId);
  clearChatSession(contextId);
  resetConversation(contextId);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: '工作目录已切换',
    template: 'green',
    summary: `**当前目录**：${resolved.path}`,
    body: '已同时清空当前 project 下的 Codex session 和上下文，避免新项目串到旧任务。',
  }, replyToMessageId);
}

function resolveWorkspacePath(target, baseCwd) {
  const raw = String(target || '').trim();
  if (!raw) return { ok: false, message: '缺少目录路径。' };
  const expanded = raw === '~' ? homeDir() : raw.replace(/^~(?=\/|$)/, homeDir());
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd || config.codexCwd, expanded);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return { ok: false, message: `目录不存在：${absolute}` };
  }
  try {
    if (!fs.statSync(real).isDirectory()) {
      return { ok: false, message: `不是目录：${real}` };
    }
  } catch {
    return { ok: false, message: `无法访问目录：${real}` };
  }
  return { ok: true, path: real };
}

function saveAccess(access) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${ACCESS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, ACCESS_FILE);
}

function effectiveChatPreferences(chatId) {
  const access = config.accessEnabled ? readAccessFile() : {};
  const chatPrefs = access.chatPreferences && access.chatPreferences[chatId] && typeof access.chatPreferences[chatId] === 'object'
    ? access.chatPreferences[chatId]
    : {};
  const groupPolicy = access.groups && access.groups[chatId] && typeof access.groups[chatId] === 'object'
    ? access.groups[chatId]
    : {};
  return {
    replyMode: chatPrefs.replyMode === 'text' ? 'text' : 'card',
    showToolCalls: typeof chatPrefs.showToolCalls === 'boolean' ? chatPrefs.showToolCalls : config.streamOutput,
    requireMention: typeof groupPolicy.requireMention === 'boolean' ? groupPolicy.requireMention : true,
  };
}

function updateChatPreference(chatId, key, value) {
  if (!config.accessEnabled || !chatId) return;
  const access = readAccessFile();
  if (key === 'requireMention') {
    access.groups = access.groups && typeof access.groups === 'object' ? access.groups : {};
    const existing = access.groups[chatId] && typeof access.groups[chatId] === 'object' ? access.groups[chatId] : {};
    access.groups[chatId] = {
      ...existing,
      requireMention: Boolean(value),
    };
  } else if (key === 'replyMode' || key === 'showToolCalls') {
    access.chatPreferences = access.chatPreferences && typeof access.chatPreferences === 'object' ? access.chatPreferences : {};
    const existing = access.chatPreferences[chatId] && typeof access.chatPreferences[chatId] === 'object' ? access.chatPreferences[chatId] : {};
    access.chatPreferences[chatId] = {
      ...existing,
      [key]: key === 'replyMode' && value === 'text' ? 'text' : (key === 'replyMode' ? 'card' : Boolean(value)),
      updatedAt: new Date().toISOString(),
    };
  }
  saveAccess(access);
}

function updateGlobalPreference(key, value) {
  if (!config.accessEnabled) return;
  const access = readAccessFile();
  access.preferences = access.preferences && typeof access.preferences === 'object' ? access.preferences : {};
  access.preferences[key] = value;
  access.preferences.updatedAt = new Date().toISOString();
  saveAccess(access);
}

function effectiveMaxConcurrentTasks() {
  const access = config.accessEnabled ? readAccessFile() : {};
  const value = access.preferences && Number(access.preferences.maxConcurrentTasks);
  return clampInt(Number.isFinite(value) ? value : config.maxConcurrentTasks, 1, 10);
}

function shouldShowToolCalls(chatId) {
  return effectiveChatPreferences(chatId).showToolCalls;
}

function prefersPlainReplies(chatId) {
  return effectiveChatPreferences(chatId).replyMode === 'text';
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function gateMessage(input) {
  if (!config.accessEnabled) return { action: 'deliver' };
  const access = readAccessFile();
  if (pruneExpired(access)) saveAccess(access);

  if (access.dmPolicy === 'disabled') return { action: 'drop' };
  if (config.allowedChatIds.includes(input.chatId)) return { action: 'deliver' };

  if (!isGroupChat(input.chatType)) {
    if (access.allowFrom.includes(input.senderId)) return { action: 'deliver' };
    if (access.dmPolicy === 'allowlist') return { action: 'drop' };
    return pairingResult(access, input);
  }

  const policy = access.groups[input.chatId];
  if (!policy) return { action: 'drop' };
  const groupAllowFrom = Array.isArray(policy.allowFrom) ? policy.allowFrom : [];
  if (groupAllowFrom.length && !groupAllowFrom.includes(input.senderId)) return { action: 'drop' };
  if ((policy.requireMention ?? true) && !isMentioned(input.text, access.mentionPatterns, input.mentions)) {
    return { action: 'drop' };
  }
  return { action: 'deliver' };
}

function gateAction(input) {
  if (!config.accessEnabled) return { action: 'deliver' };
  const access = readAccessFile();
  if (pruneExpired(access)) saveAccess(access);
  if (access.dmPolicy === 'disabled') return { action: 'drop' };
  if (config.allowedChatIds.includes(input.chatId)) return { action: 'deliver' };
  if (!isGroupChat(input.chatType)) {
    if (access.allowFrom.includes(input.senderId)) return { action: 'deliver' };
    return { action: 'drop' };
  }
  const policy = access.groups[input.chatId];
  if (!policy) return { action: 'drop' };
  const groupAllowFrom = Array.isArray(policy.allowFrom) ? policy.allowFrom : [];
  if (groupAllowFrom.length && !groupAllowFrom.includes(input.senderId)) return { action: 'drop' };
  return { action: 'deliver' };
}

function pairingResult(access, input) {
  for (const [code, pending] of Object.entries(access.pending)) {
    if (pending.senderId === input.senderId) {
      if ((pending.replies ?? 1) >= 2) return { action: 'drop' };
      pending.replies = (pending.replies ?? 1) + 1;
      saveAccess(access);
      return { action: 'pair', code, isResend: true };
    }
  }
  if (Object.keys(access.pending).length >= 3) return { action: 'drop' };

  const code = randomBytes(3).toString('hex');
  const now = Date.now();
  access.pending[code] = {
    senderId: input.senderId,
    chatId: input.chatId,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000,
    replies: 1,
  };
  saveAccess(access);
  return { action: 'pair', code, isResend: false };
}

function pruneExpired(access) {
  const now = Date.now();
  let changed = false;
  for (const [code, pending] of Object.entries(access.pending)) {
    if (pending.expiresAt < now) {
      delete access.pending[code];
      changed = true;
    }
  }
  return changed;
}

function isGroupChat(chatType) {
  return chatType === 'group' || chatType === 'group_chat';
}

function isMentioned(text, _patterns, mentions) {
  if (Array.isArray(mentions) && mentions.length > 0) return true;
  const body = String(text || '');
  if (body.includes('<at')) return true;
  const patterns = Array.isArray(_patterns) ? _patterns : [];
  if (patterns.some((pattern) => pattern && body.includes(pattern))) return true;
  return false;
}

function checkApprovals() {
  let files;
  try {
    files = fs.readdirSync(APPROVED_DIR);
  } catch {
    return;
  }
  for (const senderId of files) {
    const file = path.join(APPROVED_DIR, senderId);
    let chatId = '';
    try {
      chatId = fs.readFileSync(file, 'utf8').trim();
    } catch {}
    if (!chatId) {
      fs.rmSync(file, { force: true });
      continue;
    }
    void sendUiMessage(chatId, {
      kind: 'success',
      title: '配对完成',
      template: 'green',
      summary: '现在可以向 Codex 发送指令。',
    }).finally(() => {
      fs.rmSync(file, { force: true });
    });
  }
}

async function startCodexTask(prompt, source) {
  const maxConcurrentTasks = effectiveMaxConcurrentTasks();
  if (running.size >= maxConcurrentTasks) {
    await sendUiMessage(
      source.chatId,
      {
        kind: 'busy',
        title: '任务队列已满',
        template: 'orange',
        summary: `当前已有 ${running.size} 个任务运行中，上限 ${maxConcurrentTasks}。`,
        body: `查看状态：\`${config.commandPrefix} status\`\n取消任务：\`${config.commandPrefix} cancel <taskId>\``,
      },
      source.messageId,
    );
    return;
  }

  const taskId = `codex-${Date.now()}-${++taskSeq}`;
  const startedAt = Date.now();
  const outputFile = path.join(DATA_DIR, `${taskId}.last-message.txt`);
  const workspace = workspaceForChat(source.chatId);
  const contextId = source.contextId || source.chatId;
  const runTimeout = effectiveRunTimeout(contextId, workspace.name);
  if (source.resetSession) clearChatSession(contextId, workspace.name);
  const existingSession = config.codexSessionsEnabled ? sessionForChat(contextId, workspace.name) : '';
  const shouldResume = Boolean(existingSession && !source.resetSession);
  const cwd = workspace.cwd;
  const bridgePrompt = buildOutboundMediaPrompt(prompt, cwd);
  const codexPrompt = shouldResume ? bridgePrompt : buildPromptWithMemory(contextId, bridgePrompt, source.useMemory, workspace.name);
  const args = shouldResume
    ? ['exec', 'resume', ...config.codexExtraArgs]
    : ['exec', ...config.codexExtraArgs];
  if (!args.includes('--json')) args.push('--json');
  if (config.codexModel) args.push('-m', config.codexModel);
  args.push('-o', outputFile);
  if (shouldResume) {
    args.push(existingSession, codexPrompt);
  } else {
    args.push('-C', cwd, codexPrompt);
  }

  await sendTaskStarted(source.chatId, {
    taskId,
    workspaceName: workspace.name,
    cwd,
    sessionId: shouldResume ? existingSession : '',
    isResume: shouldResume,
    contextLabel: source.contextLabel,
    useMemory: source.useMemory,
    memoryReason: source.memoryReason,
    prompt,
    runTimeout,
  }, source.messageId);
  log(`task ${taskId} start from=${source.senderId || 'unknown'} chat=${source.chatId} context=${contextId} workspace=${workspace.name} cwd=${cwd} session=${shouldResume ? existingSession : 'new'} memory=${source.useMemory ? source.memoryReason : 'new'} prompt=${singleLine(prompt).slice(0, 500)}`);

  const child = spawn(config.codexBin, args, {
    cwd,
    env: {
      ...process.env,
      PATH: buildPath(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const task = {
    id: taskId,
    child,
    chatId: source.chatId,
    contextId,
    messageId: source.messageId,
    startedAt,
    output: '',
    stderr: '',
    buffer: '',
    userPrompt: prompt,
    outputFile,
    workspaceName: workspace.name,
    cwd,
    sessionId: shouldResume ? existingSession : '',
    jsonOutput: true,
    jsonRemainder: '',
    timer: null,
    timeoutTimer: null,
    runTimeout,
    lastActivityAt: Date.now(),
    killedByUser: false,
    showToolCalls: shouldShowToolCalls(source.chatId),
  };
  running.set(taskId, task);

  resetRunWatchdog(task);

  child.stdout.on('data', (chunk) => appendOutput(task, chunk.toString(), false));
  child.stderr.on('data', (chunk) => appendOutput(task, chunk.toString(), true));
  child.on('error', async (err) => {
    clearRunWatchdog(task);
    running.delete(taskId);
    await flushTaskBuffer(task);
    await sendUiMessage(source.chatId, {
      kind: 'error',
      title: '任务启动失败',
      template: 'red',
      summary: taskId,
      body: err.message,
    }, source.messageId);
    log(`task ${taskId} spawn error: ${err.stack || err.message}`);
  });
  child.on('close', async (code, signal) => {
    clearRunWatchdog(task);
    running.delete(taskId);
    if (task.jsonOutput && task.jsonRemainder) appendCodexJsonOutput(task, '\n');
    await flushTaskBuffer(task);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const tail = compactTail(task.output || task.stderr, 3000);
    const verdict = code === 0 && !signal ? '完成' : (task.killedByUser ? '已取消/超时' : '失败');
    const finalMessage = readFinalMessage(task);
    if (code === 0 && !signal && finalMessage) {
      if (config.codexSessionsEnabled && task.sessionId) {
        setChatSession(contextId, task.sessionId, cwd, taskId, task.workspaceName);
      }
      appendConversationTurn(contextId, task.userPrompt, finalMessage, task.workspaceName);
    }
    await sendTaskFinished(source.chatId, {
      taskId,
      verdict,
      code,
      signal,
      elapsed,
      finalMessage,
      tail,
    }, source.messageId);
    log(`task ${taskId} close code=${code} signal=${signal} elapsed=${elapsed}s`);
  });
}

function appendOutput(task, text, isStderr) {
  noteTaskActivity(task);
  if (!isStderr && task.jsonOutput) {
    appendCodexJsonOutput(task, text);
    return;
  }
  if (isStderr) task.stderr += text;
  else task.output += text;

  task.buffer += text;
  if (task.buffer.length > 3500) {
    void flushTaskBuffer(task);
    return;
  }
  if (!task.timer) {
    task.timer = setTimeout(() => {
      task.timer = null;
      void flushTaskBuffer(task);
    }, 5000);
    task.timer.unref();
  }
}

function appendCodexJsonOutput(task, text) {
  task.jsonRemainder = `${task.jsonRemainder || ''}${text}`;
  const lines = task.jsonRemainder.split(/\r?\n/);
  task.jsonRemainder = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      task.output += `${line}\n`;
      continue;
    }

    if (event.type === 'thread.started' && event.thread_id) {
      task.sessionId = event.thread_id;
      appendOutputText(task, `Codex session: ${event.thread_id}\n`);
      continue;
    }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
      appendOutputText(task, `${event.item.text || ''}\n`);
      continue;
    }
    if (event.type === 'turn.completed') {
      appendOutputText(task, 'Codex turn completed.\n');
    }
  }
}

function appendOutputText(task, text) {
  noteTaskActivity(task);
  task.output += text;
  task.buffer += text;
  if (task.buffer.length > 3500) {
    void flushTaskBuffer(task);
    return;
  }
  if (!task.timer) {
    task.timer = setTimeout(() => {
      task.timer = null;
      void flushTaskBuffer(task);
    }, 5000);
    task.timer.unref();
  }
}

function noteTaskActivity(task) {
  task.lastActivityAt = Date.now();
  resetRunWatchdog(task);
}

function resetRunWatchdog(task) {
  clearRunWatchdog(task);
  if (!task.runTimeout || task.runTimeout.mode === 'off' || !task.runTimeout.ms) return;
  task.timeoutTimer = setTimeout(() => {
    const idleFor = Date.now() - (task.lastActivityAt || task.startedAt || Date.now());
    if (idleFor < task.runTimeout.ms) {
      resetRunWatchdog(task);
      return;
    }
    task.killedByUser = true;
    task.output += `\nRun watchdog killed task after ${formatDuration(Math.round(idleFor / 1000))} without output.\n`;
    task.child.kill('SIGTERM');
    setTimeout(() => task.child.kill('SIGKILL'), 5000).unref();
  }, task.runTimeout.ms);
  task.timeoutTimer.unref();
}

function clearRunWatchdog(task) {
  if (task.timeoutTimer) {
    clearTimeout(task.timeoutTimer);
    task.timeoutTimer = null;
  }
}

async function flushTaskBuffer(task) {
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = null;
  }

  const buffered = task.buffer;
  task.buffer = '';
  if (!buffered.trim() || !task.showToolCalls) return;

  const chunks = chunkText(buffered, 3500);
  for (const chunk of chunks) {
    await sendLogChunk(task.chatId, task.id, chunk, task.messageId);
  }
}

async function cancelTask(taskId, chatId, replyToMessageId) {
  if (!taskId) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '缺少任务 ID',
      template: 'orange',
      summary: `示例：${config.commandPrefix} cancel codex-...`,
    }, replyToMessageId);
    return;
  }
  const task = running.get(taskId);
  if (!task) {
    await sendUiMessage(chatId, {
      kind: 'warn',
      title: '未找到任务',
      template: 'orange',
      summary: taskId,
    }, replyToMessageId);
    return;
  }
  task.killedByUser = true;
  task.child.kill('SIGTERM');
  setTimeout(() => task.child.kill('SIGKILL'), 5000).unref();
  await sendUiMessage(chatId, {
    kind: 'cancel',
    title: '已请求取消',
    template: 'orange',
    summary: taskId,
  }, replyToMessageId);
}

async function cancelChatTasks(chatId, replyToMessageId, options = {}) {
  const tasks = Array.from(running.values()).filter((task) => {
    if (task.chatId !== chatId) return false;
    return !options.contextId || task.contextId === options.contextId;
  });
  if (!tasks.length) {
    if (!options.quietWhenEmpty) {
      await sendUiMessage(chatId, {
        kind: 'warn',
        title: '当前会话没有运行中的任务',
        template: 'orange',
        summary: '无需停止。',
      }, replyToMessageId);
    }
    return 0;
  }

  for (const task of tasks) {
    task.killedByUser = true;
    task.child.kill('SIGTERM');
    setTimeout(() => task.child.kill('SIGKILL'), 5000).unref();
  }
  await sendUiMessage(chatId, {
    kind: 'cancel',
    title: options.contextId ? '已请求停止当前 thread 任务' : '已请求停止当前会话任务',
    template: 'orange',
    summary: tasks.map((task) => task.id).join('\n'),
  }, replyToMessageId);
  return tasks.length;
}

async function sendUiMessage(chatId, message, replyToMessageId) {
  const body = [message.summary, message.body].filter(Boolean).join('\n\n');
  const fallback = [message.title, body].filter(Boolean).join('\n\n');
  await sendCard(chatId, {
    header: {
      template: message.template || 'blue',
      title: { tag: 'plain_text', content: message.title || 'Codex' },
    },
    elements: cardElements([
      message.summary ? { tag: 'markdown', content: message.summary } : null,
      message.body ? { tag: 'markdown', content: message.body } : null,
    ]),
  }, fallback, replyToMessageId);
}

async function sendTaskStarted(chatId, task, replyToMessageId) {
  const details = [
    `**任务 ID**：${task.taskId}`,
    task.contextLabel ? `**Session scope**：${task.contextLabel}` : null,
    `**Workspace**：${task.workspaceName || 'default'}`,
    `**工作目录**：${task.cwd}`,
    `**Codex session**：${task.isResume ? `继续 ${task.sessionId}` : '新建'}`,
    `**上下文**：${task.isResume ? '使用 Codex 原生会话' : (task.useMemory ? `继续模式（${task.memoryReason || 'explicit'}）` : '新任务隔离')}`,
    `**Run 探活**：${timeoutStatusText(task.runTimeout)}`,
  ].filter(Boolean).join('\n');
  const promptArchive = config.archivePrompts ? archivePromptText(task.prompt) : '';
  await sendCard(chatId, {
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Codex 已接收' },
    },
    elements: cardElements([
      { tag: 'markdown', content: `任务已开始，完成后会直接返回结果。\n\n${details}` },
      promptArchive ? { tag: 'markdown', content: `**输入归档**\n${promptArchive}` } : null,
    ]),
  }, `Codex 已接收\n${details}`, replyToMessageId);
}

async function sendTaskFinished(chatId, task, replyToMessageId) {
  const success = task.verdict === '完成';
  const cancelled = task.verdict === '已取消/超时';
  const template = success ? 'green' : (cancelled ? 'orange' : 'red');
  const resultText = task.finalMessage || task.tail || '无输出。';
  const media = success ? collectOutboundMedia(resultText, task.cwd) : [];
  const rich = success ? extractRichOutputs(resultText) : { text: resultText, tables: [], cards: [], actions: [], docs: [] };
  const richCount = rich.tables.length + rich.cards.length + rich.actions.length + rich.docs.length;
  const displayText = rich.text || (richCount || media.length ? '已生成富文本/多媒体内容。' : resultText);
  const title = `Codex 任务${task.verdict}`;
  const meta = [
    `**任务 ID**：${task.taskId}`,
    `**耗时**：${formatDuration(task.elapsed)}`,
    media.length ? `**附件**：${media.length} 个本机文件将单独发送` : null,
    success ? null : `**退出码**：${task.code ?? 'n/a'}`,
    success || !task.signal ? null : `**信号**：${task.signal}`,
  ].filter(Boolean).join('\n');

  for (const [index, chunk] of chunkText(displayText, 2800, 'newline').entries()) {
    await sendCard(chatId, {
      header: {
        template,
        title: { tag: 'plain_text', content: index === 0 ? title : `${title}（续 ${index + 1}）` },
      },
      elements: cardElements([
        index === 0 ? { tag: 'markdown', content: meta } : null,
        { tag: 'markdown', content: chunk },
        !task.finalMessage && task.tail ? { tag: 'markdown', content: '_未读取到最终回复文件，展示 CLI 尾部输出。_' } : null,
      ]),
    }, `${title}\n${meta}\n\n${displayText}`, replyToMessageId);
  }
  for (const table of rich.tables) {
    await sendTableCard(chatId, table, replyToMessageId);
  }
  for (const card of rich.cards) {
    await sendCustomCard(chatId, card, replyToMessageId);
  }
  for (const actionCard of rich.actions) {
    await sendActionCard(chatId, actionCard, {
      replyToMessageId,
      contextId: task.contextId,
      contextLabel: task.workspaceName || 'current',
    });
  }
  for (const doc of rich.docs) {
    await sendFeishuDocCard(chatId, doc, replyToMessageId);
  }
  if (media.length) {
    await sendOutboundMedia(chatId, media, replyToMessageId);
  }
}

async function sendLogChunk(chatId, taskId, chunk, replyToMessageId) {
  await sendCard(chatId, {
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: 'Codex 实时输出' },
    },
    elements: cardElements([
      { tag: 'markdown', content: `**任务 ID**：${taskId}` },
      { tag: 'markdown', content: codeBlock(compactMiddle(chunk, 2600)) },
    ]),
  }, `任务 ${taskId} 实时输出：\n${chunk}`, replyToMessageId);
}

async function sendTableCard(chatId, table, replyToMessageId) {
  const rows = parseTableRows(table.content);
  const elements = [];
  if (table.title) {
    elements.push({ tag: 'markdown', content: `**${escapeMarkdownLine(table.title)}**` });
  }
  if (rows.length) {
    elements.push(...tableElements(rows));
  } else {
    elements.push({ tag: 'markdown', content: compactMiddle(table.content, 3000) });
  }
  await sendCard(chatId, {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: table.title || '表格' },
    },
    elements: cardElements(elements),
  }, `${table.title || '表格'}\n${table.content}`, replyToMessageId);
}

async function sendCustomCard(chatId, card, replyToMessageId) {
  await sendCard(chatId, card, JSON.stringify(card).slice(0, 3000), replyToMessageId);
}

async function sendActionCard(chatId, actionCard, options) {
  const actions = Array.isArray(actionCard.actions) ? actionCard.actions.slice(0, 6) : [];
  if (!actions.length) return;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: actionCard.template || 'blue',
      title: { tag: 'plain_text', content: actionCard.title || '选择下一步' },
    },
    elements: cardElements([
      actionCard.body ? { tag: 'markdown', content: String(actionCard.body).slice(0, 2500) } : null,
      {
        tag: 'action',
        layout: actions.length >= 3 ? 'flow' : 'bisected',
        actions: actions.map((action, index) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: String(action.label || `选项 ${index + 1}`).slice(0, 40) },
          type: ['primary', 'danger', 'default'].includes(action.type) ? action.type : (index === 0 ? 'primary' : 'default'),
          value: {
            kind: 'codex_prompt',
            label: String(action.label || `选项 ${index + 1}`),
            prompt: String(action.prompt || action.value || action.label || ''),
            chatId,
            contextId: options.contextId,
            contextLabel: options.contextLabel,
          },
        })),
      },
    ]),
  };
  await sendCard(chatId, card, `${actionCard.title || '选择下一步'}\n${actions.map((action) => `- ${action.label}: ${action.prompt || action.value || ''}`).join('\n')}`, options.replyToMessageId);
}

async function sendFeishuDocCard(chatId, doc, replyToMessageId) {
  try {
    const created = await createFeishuDoc(doc);
    await sendCard(chatId, {
      config: { wide_screen_mode: true },
      header: {
        template: 'purple',
        title: { tag: 'plain_text', content: '飞书文档已创建' },
      },
      elements: cardElements([
        { tag: 'markdown', content: `**${escapeMarkdownLine(created.title)}**\n\n可以直接在飞书文档里阅读、评论和反馈。` },
        {
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '打开文档' },
            type: 'primary',
            url: created.url,
          }],
        },
      ]),
    }, `${created.title}\n${created.url}`, replyToMessageId);
  } catch (err) {
    log(`create feishu doc failed: ${err.stack || err.message || err}`);
    await sendCard(chatId, {
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '飞书文档创建失败' },
      },
      elements: cardElements([
        { tag: 'markdown', content: `已保留正文，下面以消息形式发送。\n\n${compactMiddle(doc.content, 3000)}` },
      ]),
    }, `${doc.title || '飞书文档创建失败'}\n${doc.content}`, replyToMessageId);
  }
}

async function createFeishuDoc(doc) {
  const documentApi = client.docx && (client.docx.document || (client.docx.v1 && client.docx.v1.document));
  const childrenApi = client.docx && (client.docx.documentBlockChildren || (client.docx.v1 && client.docx.v1.documentBlockChildren));
  if (!documentApi || !childrenApi) throw new Error('Feishu docx API is unavailable in current SDK client');

  const title = safeDocTitle(doc.title || firstMarkdownHeading(doc.content) || 'Codex 文档');
  const createPayload = { data: { title } };
  if (config.feishuDocFolderToken) createPayload.data.folder_token = config.feishuDocFolderToken;
  const created = await documentApi.create(createPayload);
  const documentId = created && created.data && created.data.document && created.data.document.document_id;
  if (!documentId) throw new Error(`create document returned no document_id: ${JSON.stringify(created).slice(0, 500)}`);

  const blocks = await markdownToFeishuBlocks(doc.content, documentApi);
  if (blocks.length) {
    await childrenApi.create({
      path: { document_id: documentId, block_id: documentId },
      data: {
        children: blocks.slice(0, 200),
        client_token: randomBytes(8).toString('hex'),
      },
    });
  }

  return {
    title,
    documentId,
    url: `${config.feishuDocBaseUrl.replace(/\/$/, '')}/${documentId}`,
  };
}

async function markdownToFeishuBlocks(markdown, documentApi) {
  const content = String(markdown || '').trim();
  if (!content) return [];
  if (typeof documentApi.convert === 'function') {
    try {
      const converted = await documentApi.convert({
        data: { content_type: 'markdown', content: compactMiddle(content, 120000) },
      });
      const blocks = converted && converted.data && Array.isArray(converted.data.blocks) ? converted.data.blocks : [];
      const firstLevelIds = converted && converted.data && Array.isArray(converted.data.first_level_block_ids)
        ? converted.data.first_level_block_ids
        : [];
      const ordered = flattenConvertedBlocks(blocks, firstLevelIds).map(sanitizeDocBlock).filter(Boolean);
      if (ordered.length) return ordered;
    } catch (err) {
      log(`convert markdown to feishu doc blocks failed, fallback to plain blocks: ${err.stack || err.message || err}`);
    }
  }
  return fallbackMarkdownBlocks(content);
}

function flattenConvertedBlocks(blocks, firstLevelIds) {
  if (!firstLevelIds.length) return blocks;
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const result = [];
  const visit = (id) => {
    const block = byId.get(id);
    if (!block) return;
    result.push(block);
    for (const childId of block.children || []) visit(childId);
  };
  for (const id of firstLevelIds) visit(id);
  return result;
}

function sanitizeDocBlock(block) {
  if (!block || typeof block !== 'object' || !block.block_type) return null;
  const clone = { ...block };
  delete clone.block_id;
  delete clone.parent_id;
  delete clone.children;
  return clone;
}

function fallbackMarkdownBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    const content = paragraph.join('\n').trim();
    paragraph = [];
    if (content) blocks.push(docTextBlock(content));
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push(docTextBlock(heading[2].trim(), heading[1].length + 2));
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
    if (blocks.length >= 200) break;
  }
  flush();
  return blocks.length ? blocks : [docTextBlock(markdown)];
}

function docTextBlock(content, blockType = 2) {
  const field = blockType === 3 ? 'heading1' : (blockType === 4 ? 'heading2' : (blockType === 5 ? 'heading3' : 'text'));
  return {
    block_type: blockType,
    [field]: {
      elements: [{ text_run: { content: String(content || '').slice(0, 1800) } }],
    },
  };
}

function firstMarkdownHeading(markdown) {
  const match = String(markdown || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function safeDocTitle(title) {
  return String(title || 'Codex 文档').replace(/[\r\n\t]/g, ' ').replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Codex 文档';
}

async function sendStatus(chatId, replyToMessageId, contextId = chatId, contextLabel = '') {
  const fields = [];
  if (!running.size) {
    fields.push('**运行中任务**：0');
  } else {
    fields.push(`**运行中任务**：${running.size}`);
    for (const task of running.values()) {
      const sameChat = task.chatId === chatId ? '当前会话' : '其他会话';
      fields.push(`- ${task.id}，${sameChat}，workspace=${task.workspaceName || 'default'}，已运行 ${formatDuration(Math.round((Date.now() - task.startedAt) / 1000))}`);
    }
  }
  const workspace = workspaceForChat(chatId);
  if (contextLabel) fields.push(`**当前 session scope**：${contextLabel}`);
  fields.push(`**当前 workspace**：${workspace.name}`);
  fields.push(`**当前会话工作目录**：${workspace.cwd}`);
  fields.push(`**当前 thread Codex session**：${sessionForChat(contextId, workspace.name) || '未创建'}`);
  fields.push(`**默认工作目录**：${config.codexCwd}`);
  fields.push(`**上下文记忆**：${memoryStatusText()}`);
  fields.push(`**并发上限**：${effectiveMaxConcurrentTasks()}`);
  fields.push(`**当前 session run 探活**：${timeoutStatusText(effectiveRunTimeout(contextId, workspace.name))}`);
  fields.push(`**回复方式**：${prefersPlainReplies(chatId) ? '纯文本' : '卡片'}`);
  fields.push(`**工具调用显示**：${shouldShowToolCalls(chatId) ? '显示' : '隐藏'}`);
  await sendCard(chatId, {
    header: {
      template: running.size ? 'orange' : 'green',
      title: { tag: 'plain_text', content: 'Feishu Codex Bridge 状态' },
    },
    elements: cardElements([{ tag: 'markdown', content: fields.join('\n') }]),
  }, statusText(chatId, contextId, contextLabel), replyToMessageId);
}

async function sendHelp(chatId, replyToMessageId) {
  const commands = [
    '`/help` 查看帮助',
    '`/status` 查看状态',
    '`/config` 打开偏好设置',
    '`/timeout [分钟|off|default]` 设置当前 session run 探活',
    '`/account` 查看应用；`/account change <appId> <secret>` 热切换应用',
    '`/new` 开始新任务并清空当前会话上下文',
    '`/new chat <名字>` 自动创建一个新 project 群',
    '`/resume [N]` 列出最近 N 个历史会话并一键恢复',
    '`/stop` 停止当前飞书会话的运行中任务',
    '`/cancel <taskId>` 按任务 ID 取消',
    '`/cd <目录>` 切换当前飞书会话的工作目录',
    '`/ws list` 查看 workspace；`/ws save <名字>` 保存；`/ws use <名字>` 切换；`/ws remove <名字>` 删除',
    '直接发送需求、图片或文件即可执行任务；已授权群聊无需 @机器人。',
    `给任意消息添加 ${config.codexReactionEmojis[0] || '配置的'} reaction，可一键转给 Codex 处理。`,
  ];
  const workspace = workspaceForChat(chatId);
  await sendCard(chatId, {
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Feishu Codex Bridge' },
    },
    elements: cardElements([
      { tag: 'markdown', content: commands.join('\n') },
      { tag: 'markdown', content: `**当前 workspace**：${workspace.name}\n**当前目录**：${workspace.cwd}\n**Codex session**：${sessionForChat(chatId) || '未创建'}` },
      { tag: 'markdown', content: `**会话用法**\n一个群就是一个 project；每个话题/thread 是独立 Codex session。\n图片和文件会先下载到本机，再把路径交给 Codex 读取。\n需要彻底开新任务时用 \`/new\`。需要新 project 群时用 \`/new chat <名字>\`。` },
    ]),
  }, helpText(chatId), replyToMessageId);
}

async function sendCard(chatId, card, fallbackText, replyToMessageId, options = {}) {
  if (!options.forceCard && prefersPlainReplies(chatId)) {
    await sendText(chatId, fallbackText, replyToMessageId);
    return;
  }
  try {
    if (replyToMessageId) {
      await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });
    } else {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    }
  } catch (err) {
    log(`send card failed replyTo=${replyToMessageId || 'n/a'}: ${formatApiError(err)}`);
    await sendText(chatId, fallbackText, replyToMessageId);
  }
}

async function sendText(chatId, text, replyToMessageId) {
  const access = config.accessEnabled ? readAccessFile() : {};
  const limit = Math.max(1, Math.min(access.textChunkLimit || 3900, 3900));
  for (const chunk of chunkText(String(text || ''), limit, access.chunkMode || 'newline')) {
    try {
      if (replyToMessageId) {
        await client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
            reply_in_thread: true,
          },
        });
      } else {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      }
    } catch (err) {
      log(`send message failed replyTo=${replyToMessageId || 'n/a'}: ${formatApiError(err)}`);
    }

    if (config.webhookUrl && config.webhookMirror) {
      await sendWebhookText(chunk);
    }
  }
}

async function sendOutboundMedia(chatId, media, replyToMessageId) {
  for (const item of media) {
    try {
      if (item.kind === 'image') {
        await sendImageFile(chatId, item.path, replyToMessageId);
      } else {
        await sendGenericFile(chatId, item.path, replyToMessageId);
      }
      log(`sent outbound media kind=${item.kind} path=${item.path}`);
    } catch (err) {
      log(`send outbound media failed path=${item.path}: ${err.stack || err.message || err}`);
      await sendUiMessage(chatId, {
        kind: 'warn',
        title: '附件发送失败',
        template: 'orange',
        summary: path.basename(item.path),
        body: `已保留本机路径：\`${item.path}\`\n${formatApiError(err)}`,
      }, replyToMessageId);
    }
  }
}

async function sendImageFile(chatId, filePath, replyToMessageId) {
  const uploaded = await client.im.image.create({
    data: {
      image_type: 'message',
      image: fs.createReadStream(filePath),
    },
  });
  const imageKey = uploaded && uploaded.image_key;
  if (!imageKey) throw new Error(`image upload returned no image_key: ${JSON.stringify(uploaded).slice(0, 1000)}`);
  await sendRawMessage(chatId, 'image', { image_key: imageKey }, replyToMessageId);
}

async function sendGenericFile(chatId, filePath, replyToMessageId) {
  const uploaded = await client.im.file.create({
    data: {
      file_type: feishuFileType(filePath),
      file_name: path.basename(filePath),
      file: fs.createReadStream(filePath),
    },
  });
  const fileKey = uploaded && uploaded.file_key;
  if (!fileKey) throw new Error(`file upload returned no file_key: ${JSON.stringify(uploaded).slice(0, 1000)}`);
  await sendRawMessage(chatId, 'file', { file_key: fileKey }, replyToMessageId);
}

async function sendRawMessage(chatId, msgType, content, replyToMessageId) {
  if (replyToMessageId) {
    await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        msg_type: msgType,
        content: JSON.stringify(content),
        reply_in_thread: true,
      },
    });
    return;
  }
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
    },
  });
}

async function sendWebhookText(text) {
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text },
      }),
    });
    if (!response.ok) {
      log(`webhook send failed: http ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    log(`webhook send failed: ${err.stack || err.message || err}`);
  }
}

function messageContext(message) {
  const chatId = message.chat_id;
  const chatType = message.chat_type;
  if (!isGroupChat(chatType)) {
    return {
      chatId,
      chatType,
      threadId: '',
      contextId: chatId,
      label: '私聊',
    };
  }

  const threadId = message.thread_id || message.root_id || message.message_id;
  return {
    chatId,
    chatType,
    threadId,
    contextId: `${chatId}::thread:${threadId}`,
    label: message.thread_id || message.root_id ? `thread ${threadId}` : `new thread ${threadId}`,
  };
}

function extractText(message) {
  const parsed = parseMessageContent(message);
  if (message.message_type === 'post') return extractPostText(parsed).trim();
  return String(parsed.text || '').trim();
}

function parseMessageContent(message) {
  try {
    const parsed = JSON.parse(message.content || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractAttachments(message) {
  const parsed = parseMessageContent(message);
  const type = message.message_type;
  if (type === 'image' && parsed.image_key) {
    return [{
      type: 'image',
      fileKey: parsed.image_key,
      fileName: safeAttachmentFileName(parsed.file_name || parsed.name || 'image.png', 'image.png'),
    }];
  }
  if (type === 'file' && parsed.file_key) {
    return [{
      type: 'file',
      fileKey: parsed.file_key,
      fileName: safeAttachmentFileName(parsed.file_name || parsed.name || 'file', 'file'),
    }];
  }
  if (type === 'post') return extractPostImages(parsed);
  return [];
}

function extractPostText(value) {
  const parts = [];
  walkPostContent(value, (node) => {
    if (typeof node.text === 'string') parts.push(node.text);
    if (typeof node.un_escape_text === 'string') parts.push(node.un_escape_text);
  });
  return parts.join(' ').replace(/\s+/g, ' ');
}

function extractPostImages(value) {
  const images = [];
  walkPostContent(value, (node) => {
    if (node.image_key) {
      images.push({
        type: 'image',
        fileKey: node.image_key,
        fileName: safeAttachmentFileName(node.file_name || node.name || `image-${images.length + 1}.png`, `image-${images.length + 1}.png`),
      });
    }
  });
  return images;
}

function walkPostContent(value, visit) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) walkPostContent(item, visit);
    return;
  }
  if (typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value.content)) walkPostContent(value.content, visit);
  if (Array.isArray(value.children)) walkPostContent(value.children, visit);
}

async function downloadMessageAttachments(message, attachments) {
  const messageId = message.message_id;
  const chatToken = safeFileToken(message.chat_id);
  const messageToken = safeFileToken(messageId);
  const dir = path.join(ATTACHMENT_DIR, chatToken, messageToken);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const used = new Set();
  const files = [];
  for (const attachment of attachments) {
    const fileName = uniqueFileName(attachment.fileName, used);
    const filePath = path.join(dir, fileName);
    await downloadMessageResource(messageId, attachment, filePath);
    files.push({
      ...attachment,
      fileName,
      path: filePath,
      size: fileSize(filePath),
    });
  }
  return files;
}

async function downloadMessageResource(messageId, attachment, filePath) {
  const response = await client.im.messageResource.get({
    path: {
      message_id: messageId,
      file_key: attachment.fileKey,
    },
    params: {
      type: attachment.type,
    },
  });
  await response.writeFile(filePath);
}

function buildAttachmentPrompt(userText, files) {
  const lines = [
    '用户通过飞书发送了附件。附件已经下载到这台机器的本机路径；请直接读取这些路径，不要向用户索要文件。',
    '',
    '用户要求：',
    String(userText || '').trim() || '请读取附件并回复。',
    '',
    '本机附件路径：',
  ];
  files.forEach((file, index) => {
    const size = file.size === null ? '' : `, size=${file.size} bytes`;
    lines.push(`${index + 1}. ${file.type}: ${file.path} (name=${file.fileName}${size})`);
  });
  return lines.join('\n');
}

function safeAttachmentFileName(name, fallback) {
  const cleaned = path.basename(String(name || fallback || 'attachment'))
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 180) || fallback || 'attachment';
}

function uniqueFileName(fileName, used) {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${parsed.name || 'attachment'}-${index}${parsed.ext || ''}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

function stripMention(text) {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/gi, '')
    .replace(/@\S+\s*/g, '')
    .trim();
}

function statusText(chatId, contextId = chatId, contextLabel = '') {
  const workspace = workspaceForChat(chatId);
  const preferences = `并发上限：${effectiveMaxConcurrentTasks()}\n当前 session run 探活：${timeoutStatusText(effectiveRunTimeout(contextId, workspace.name))}\n回复方式：${prefersPlainReplies(chatId) ? '纯文本' : '卡片'}\n工具调用显示：${shouldShowToolCalls(chatId) ? '显示' : '隐藏'}`;
  if (!running.size) return `当前没有运行中的 Codex 任务。桥接服务在线。\n${contextLabel ? `当前 session scope：${contextLabel}\n` : ''}当前 workspace：${workspace.name}\n当前会话工作目录：${workspace.cwd}\n当前 thread Codex session：${sessionForChat(contextId, workspace.name) || '未创建'}\n${conversationStatusText()}\n${preferences}`;
  const lines = ['运行中的任务：'];
  for (const task of running.values()) {
    lines.push(`- ${task.id}，workspace=${task.workspaceName || 'default'}，已运行 ${Math.round((Date.now() - task.startedAt) / 1000)}s`);
  }
  lines.push(`当前 workspace：${workspace.name}`);
  lines.push(`当前会话工作目录：${workspace.cwd}`);
  if (contextLabel) lines.push(`当前 session scope：${contextLabel}`);
  lines.push(`当前 thread Codex session：${sessionForChat(contextId, workspace.name) || '未创建'}`);
  lines.push(conversationStatusText());
  lines.push(preferences);
  return lines.join('\n');
}

function conversationStatusText() {
  const codexSession = config.codexSessionsEnabled ? 'Codex session：开启' : 'Codex session：关闭';
  if (!config.memoryEnabled) return `${codexSession}\n上下文记忆：关闭`;
  return `${codexSession}\n上下文记忆：${memoryStatusText()}`;
}

function memoryStatusText() {
  if (!config.memoryEnabled) return '关闭';
  if (config.memoryMode === 'always') {
    return `总是携带，最多保留 ${config.memoryMaxTurns} 轮 / ${config.memoryMaxChars} 字符`;
  }
  return `显式继续时携带最近 ${config.memoryContextTurns} 轮；默认新任务隔离`;
}

function helpText(chatId) {
  const workspace = workspaceForChat(chatId);
  return [
    'Feishu Codex Bridge 在线。',
    '',
    '执行任务：直接发送需求、图片或文件',
    '查看状态：/status',
    '偏好设置：/config',
    '当前 session 探活：/timeout 15 / /timeout off / /timeout default',
    '查看/切换飞书应用：/account',
    '新任务：/new',
    '新建 project 群：/new chat <名字>',
    '恢复历史会话：/resume 5',
    '停止当前会话任务：/stop',
    '取消指定任务：/cancel <taskId>',
    '切换目录：/cd <目录>',
    '查看/切换 workspace：/ws list / /ws save <名字> / /ws use <名字> / /ws remove <名字>',
    '',
    `当前 workspace：${workspace.name}`,
    `当前会话工作目录：${workspace.cwd}`,
    `当前会话 Codex session：${sessionForChat(chatId) || '未创建'}`,
    conversationStatusText(),
  ].join('\n');
}

function buildPath() {
  const home = process.env.HOME || '/Users/macmini';
  return [
    path.join(home, '.cargo/bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.local/nodejs/node-v22.11.0-darwin-x64/bin'),
    process.env.PATH || '',
  ].join(':');
}

function splitList(value) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function splitArgs(value) {
  const matches = String(value || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ''));
}

function cardElements(elements) {
  return elements.filter(Boolean).flatMap((element, index) => {
    if (index === 0) return [element];
    return [{ tag: 'hr' }, element];
  });
}

function codeBlock(text) {
  return `\`\`\`\n${String(text || '').replace(/```/g, '``\\`')}\n\`\`\``;
}

function archivePromptText(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return '';
  const max = Math.max(200, Math.min(config.archivePromptMaxChars || 1800, 6000));
  return codeBlock(compactMiddle(text, max));
}

function compactMiddle(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.55);
  const tail = Math.max(0, max - head);
  return `${value.slice(0, head)}\n...\n${value.slice(-tail)}`;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${rest}s`;
}

function chunkText(text, size, mode = 'length') {
  if (text.length <= size) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    let cut = size;
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', size);
      const line = rest.lastIndexOf('\n', size);
      const space = rest.lastIndexOf(' ', size);
      cut = para > size / 2 ? para : line > size / 2 ? line : space > 0 ? space : size;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function compactTail(text, max) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? `...\n${cleaned.slice(-max)}` : cleaned;
}

function buildOutboundMediaPrompt(prompt, cwd) {
  if (!config.outboundMediaEnabled) return prompt;
  return [
    '你可以突破纯文字限制和飞书用户沟通：',
    '- 发送图片、长图、截图、PDF、表格、压缩包或其他文件：先保存到本机当前工作目录或 data/ /private/tmp 下，然后在最终回复里写出绝对路径，或用 Markdown 链接引用，例如 `![长图](/path/to/long.png)`、`[报告](/path/to/report.pdf)`。桥接服务会自动上传这些本机路径到飞书；不要只描述“已生成”，要给出路径。',
    '- 创建可评论的飞书文档：当用户要 specs、docs、PRD、设计文档、长说明或需要方便反馈的内容时，优先输出 fenced block：```feishu-doc title="文档标题"\\n# 标题\\n...Markdown 正文...\\n```。桥接会创建飞书文档并发送打开按钮，不要把长文档只贴成普通消息。',
    '- 渲染表格：在最终回复加入 fenced block：```feishu-table title="标题"\\n| 列1 | 列2 |\\n| --- | --- |\\n| ... | ... |\\n```。桥接会渲染成飞书表格卡片。',
    '- 发送交互卡片：在最终回复加入 fenced block：```feishu-actions\\n{"title":"选择下一步","body":"请选择","actions":[{"label":"方案A","prompt":"按方案A继续","type":"primary"},{"label":"方案B","prompt":"按方案B继续"}]}\\n```。用户点按钮后，桥接会把对应 prompt 作为同一 session 的新任务执行。',
    '- 高级卡片：如果需要完整自定义飞书卡片，可输出 ```feishu-card\\n{...完整 interactive card JSON...}\\n```。',
    `当前工作目录：${cwd}`,
    '',
    '用户请求：',
    prompt,
  ].join('\n');
}

function collectOutboundMedia(text, cwd) {
  if (!config.outboundMediaEnabled) return [];
  const found = [];
  const seen = new Set();
  const value = String(text || '');
  const patterns = [
    /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    /\[[^\]]+]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    /(?:^|[\s`"'：:])((?:~|\/)[^\s`"'<>]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?|ico|pdf|docx?|xlsx?|pptx?|csv|txt|md|json|zip|tar|gz|mp4|mov|m4a|mp3|wav))(?:$|[\s`"',，。；;）)])/gim,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const raw = decodePathCandidate(match[1]);
      const item = outboundMediaItem(raw, cwd);
      if (!item || seen.has(item.path)) continue;
      seen.add(item.path);
      found.push(item);
      if (found.length >= 8) return found;
    }
  }
  return found;
}

function extractRichOutputs(text) {
  const rich = { text: String(text || ''), tables: [], cards: [], actions: [], docs: [] };
  rich.text = rich.text.replace(/```(feishu-table|feishu-card|feishu-actions|feishu-doc)([^\n`]*)\n([\s\S]*?)```/g, (_full, kind, attrs, body) => {
    const content = String(body || '').trim();
    if (kind === 'feishu-table') {
      rich.tables.push({ title: attrValue(attrs, 'title') || '表格', content });
    } else if (kind === 'feishu-doc') {
      rich.docs.push({ title: attrValue(attrs, 'title') || firstMarkdownHeading(content) || 'Codex 文档', content });
    } else if (kind === 'feishu-card') {
      const card = parseJsonBlock(content);
      if (card) rich.cards.push(card);
    } else if (kind === 'feishu-actions') {
      const card = parseJsonBlock(content);
      if (card) rich.actions.push(card);
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return rich;
}

function attrValue(attrs, key) {
  const pattern = new RegExp(`${key}=("[^"]*"|'[^']*'|\\S+)`);
  const match = String(attrs || '').match(pattern);
  if (!match) return '';
  return match[1].replace(/^['"]|['"]$/g, '');
}

function parseJsonBlock(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseTableRows(content) {
  const lines = String(content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (lines[0].includes('|')) return parseMarkdownTable(lines);
  if (lines[0].includes(',')) return parseCsvTable(lines);
  return [];
}

function parseMarkdownTable(lines) {
  const rows = lines
    .filter((line) => line.includes('|'))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  if (rows.length < 2) return rows;
  const separator = rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
  return separator ? [rows[0], ...rows.slice(2)] : rows;
}

function parseCsvTable(lines) {
  return lines.map((line) => line.split(',').map((cell) => cell.trim()));
}

function tableElements(rows) {
  const [header = [], ...body] = rows;
  if (!header.length) return [];
  const widths = header.map((_, index) => Math.max(...rows.map((row) => String(row[index] || '').length), 3));
  const normalized = [header, ...body.slice(0, 30)];
  const markdown = normalized.map((row, rowIndex) => {
    const cells = header.map((_, index) => String(row[index] || '').padEnd(Math.min(widths[index], 24), ' '));
    const line = `| ${cells.join(' | ')} |`;
    if (rowIndex !== 0) return line;
    return `${line}\n| ${header.map((_, index) => '-'.repeat(Math.min(widths[index], 24))).join(' | ')} |`;
  }).join('\n');
  const elements = [{ tag: 'markdown', content: markdown }];
  if (body.length > 30) {
    elements.push({ tag: 'markdown', content: `_仅展示前 30 行，共 ${body.length} 行数据。_` });
  }
  return elements;
}

function escapeMarkdownLine(text) {
  return String(text || '').replace(/\n/g, ' ').trim();
}

function outboundMediaItem(rawPath, cwd) {
  const resolved = resolveOutboundPath(rawPath, cwd);
  if (!resolved) return null;
  const stat = fileStat(resolved);
  if (!stat || !stat.isFile() || stat.size <= 0) return null;
  const kind = imageExtensions().has(path.extname(resolved).toLowerCase()) ? 'image' : 'file';
  const max = kind === 'image' ? 10 * 1024 * 1024 : 30 * 1024 * 1024;
  if (stat.size > max) return null;
  return { kind, path: resolved, size: stat.size };
}

function resolveOutboundPath(rawPath, cwd) {
  const raw = String(rawPath || '').trim().replace(/^file:\/\//, '');
  if (!raw) return '';
  const expanded = raw === '~' ? homeDir() : raw.replace(/^~(?=\/|$)/, homeDir());
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd || config.codexCwd, expanded);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return '';
  }
  if (!isAllowedOutboundPath(real, cwd)) return '';
  return real;
}

function isAllowedOutboundPath(filePath, cwd) {
  const roots = [
    cwd,
    config.codexCwd,
    DATA_DIR,
    '/private/tmp',
    ...config.outboundMediaDirs,
  ].filter(Boolean);
  return roots.some((root) => isInsidePath(filePath, root));
}

function isInsidePath(filePath, root) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodePathCandidate(value) {
  try {
    return decodeURIComponent(String(value || '').trim());
  } catch {
    return String(value || '').trim();
  }
}

function imageExtensions() {
  return new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico']);
}

function feishuFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.mov') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return 'xls';
  if (ext === '.ppt' || ext === '.pptx') return 'ppt';
  if (['.opus', '.mp3', '.m4a', '.wav'].includes(ext)) return 'opus';
  return 'stream';
}

function fileStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function buildPromptWithMemory(chatId, prompt, useMemory, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  if (!config.memoryEnabled) return prompt;
  if (!useMemory) return prompt;
  const conversation = loadConversation(chatId, workspaceName);
  const turns = (conversation.turns || []).slice(-Math.max(1, config.memoryContextTurns));
  if (!turns.length) return prompt;

  const lines = [
    '下面是用户明确要求继续/参考的最近上下文。只在当前请求确实依赖这些信息时使用；如果历史与当前请求冲突，以当前请求为准。',
    '',
  ];
  for (const turn of turns) {
    lines.push(`用户：${turn.user}`);
    lines.push(`助手：${turn.assistant}`);
    lines.push('');
  }
  lines.push('当前用户请求：');
  lines.push(prompt);

  return trimFromStart(lines.join('\n'), config.memoryMaxChars + prompt.length + 1000);
}

function appendConversationTurn(chatId, userPrompt, assistantMessage, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  if (!config.memoryEnabled) return;
  const conversation = loadConversation(chatId, workspaceName);
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  turns.push({
    at: new Date().toISOString(),
    user: trimFromStart(String(userPrompt || '').trim(), 2000),
    assistant: trimFromStart(String(assistantMessage || '').trim(), 4000),
  });

  conversation.chatId = chatId;
  conversation.workspaceName = workspaceName;
  conversation.updatedAt = new Date().toISOString();
  conversation.turns = trimConversation(turns);
  saveConversation(chatId, conversation, workspaceName);
}

function trimConversation(turns) {
  let kept = turns.slice(-Math.max(1, config.memoryMaxTurns));
  while (JSON.stringify(kept).length > config.memoryMaxChars && kept.length > 1) {
    kept = kept.slice(1);
  }
  return kept;
}

function loadConversation(chatId, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(conversationPath(chatId, workspaceName), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { turns: [] };
  } catch {
    return { turns: [] };
  }
}

function saveConversation(chatId, conversation, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  try {
    fs.writeFileSync(conversationPath(chatId, workspaceName), `${JSON.stringify(conversation, null, 2)}\n`);
  } catch (err) {
    log(`conversation save failed chat=${chatId}: ${err.stack || err.message || err}`);
  }
}

function resetConversation(chatId, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  try {
    fs.rmSync(conversationPath(chatId, workspaceName), { force: true });
  } catch (err) {
    log(`conversation reset failed chat=${chatId}: ${err.stack || err.message || err}`);
  }
}

function cwdForChat(chatId) {
  return workspaceForChat(chatId).cwd;
}

function projectChatId(contextId) {
  return String(contextId || '').split('::thread:')[0] || contextId;
}

function setChatCwd(chatId, cwd) {
  const state = workspaceStateForChat(chatId);
  setNamedWorkspace(chatId, state.current, cwd, true);
}

function loadWorkspaces() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? { chats: parsed.chats || {} } : { chats: {} };
  } catch {
    return { chats: {} };
  }
}

function workspaceForChat(chatId) {
  const state = workspaceStateForChat(chatId);
  return {
    name: state.current,
    cwd: state.items[state.current] && state.items[state.current].cwd ? state.items[state.current].cwd : config.codexCwd,
  };
}

function workspaceStateForChat(chatId) {
  const workspaces = loadWorkspaces();
  const raw = workspaces.chats && workspaces.chats[chatId] && typeof workspaces.chats[chatId] === 'object'
    ? workspaces.chats[chatId]
    : {};
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};

  if (raw.cwd && !items.default) {
    items.default = { cwd: raw.cwd, updatedAt: raw.updatedAt || new Date().toISOString() };
  }
  if (!items.default) {
    items.default = { cwd: config.codexCwd, updatedAt: new Date().toISOString() };
  }

  const current = items[raw.current] ? raw.current : 'default';
  return { current, items };
}

function namedWorkspaceForChat(chatId, name) {
  const state = workspaceStateForChat(chatId);
  return state.items[normalizeWorkspaceName(name)] || null;
}

function setNamedWorkspace(chatId, name, cwd, makeCurrent) {
  const workspaceName = normalizeWorkspaceName(name) || 'default';
  const workspaces = loadWorkspaces();
  const state = workspaceStateForChat(chatId);
  state.items[workspaceName] = {
    cwd,
    updatedAt: new Date().toISOString(),
  };
  workspaces.chats = workspaces.chats && typeof workspaces.chats === 'object' ? workspaces.chats : {};
  workspaces.chats[chatId] = {
    current: makeCurrent ? workspaceName : state.current,
    items: state.items,
    updatedAt: new Date().toISOString(),
  };
  saveWorkspaces(workspaces);
}

function setCurrentWorkspace(chatId, name) {
  const workspaceName = normalizeWorkspaceName(name);
  const workspaces = loadWorkspaces();
  const state = workspaceStateForChat(chatId);
  if (!state.items[workspaceName]) return false;
  workspaces.chats = workspaces.chats && typeof workspaces.chats === 'object' ? workspaces.chats : {};
  workspaces.chats[chatId] = {
    current: workspaceName,
    items: state.items,
    updatedAt: new Date().toISOString(),
  };
  saveWorkspaces(workspaces);
  return true;
}

function deleteNamedWorkspace(chatId, name) {
  const workspaceName = normalizeWorkspaceName(name);
  const workspaces = loadWorkspaces();
  const state = workspaceStateForChat(chatId);
  if (!workspaceName || workspaceName === 'default' || !state.items[workspaceName]) return false;
  delete state.items[workspaceName];
  workspaces.chats = workspaces.chats && typeof workspaces.chats === 'object' ? workspaces.chats : {};
  workspaces.chats[chatId] = {
    current: state.current === workspaceName ? 'default' : state.current,
    items: state.items,
    updatedAt: new Date().toISOString(),
  };
  saveWorkspaces(workspaces);
  return true;
}

function normalizeWorkspaceName(name) {
  return String(name || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function saveWorkspaces(workspaces) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${WORKSPACE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(workspaces, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, WORKSPACE_FILE);
  } catch (err) {
    log(`workspace save failed: ${err.stack || err.message || err}`);
  }
}

function sessionForChat(chatId, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  if (!config.codexSessionsEnabled) return '';
  const sessions = loadSessions();
  const chat = sessions.chats && sessions.chats[chatId];
  const session = sessionEntryForWorkspace(chat, workspaceName);
  return session && session.sessionId ? session.sessionId : '';
}

function setChatSession(chatId, sessionId, cwd, taskId, workspaceName = workspaceForChat(chatId).name) {
  const sessions = loadSessions();
  const normalized = normalizeWorkspaceName(workspaceName) || 'default';
  const existing = sessions.chats && sessions.chats[chatId];
  sessions.chats = sessions.chats && typeof sessions.chats === 'object' ? sessions.chats : {};
  const workspaces = existing && existing.workspaces && typeof existing.workspaces === 'object'
    ? existing.workspaces
    : {};
  if (existing && existing.sessionId && !workspaces.default) {
    workspaces.default = {
      sessionId: existing.sessionId,
      cwd: existing.cwd,
      taskId: existing.taskId,
      updatedAt: existing.updatedAt,
    };
  }
  const existingWorkspace = workspaces[normalized] && typeof workspaces[normalized] === 'object' ? workspaces[normalized] : {};
  workspaces[normalized] = {
    ...existingWorkspace,
    sessionId,
    cwd,
    taskId,
    updatedAt: new Date().toISOString(),
  };
  sessions.chats[chatId] = {
    workspaces,
    updatedAt: new Date().toISOString(),
  };
  saveSessions(sessions);
}

function clearChatSession(chatId, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  const sessions = loadSessions();
  if (!sessions.chats || !sessions.chats[chatId]) return;
  const normalized = normalizeWorkspaceName(workspaceName) || 'default';
  const chat = sessions.chats[chatId];
  if (chat.workspaces && typeof chat.workspaces === 'object') {
    delete chat.workspaces[normalized];
    chat.updatedAt = new Date().toISOString();
    if (!Object.keys(chat.workspaces).length) delete sessions.chats[chatId];
  } else {
    delete sessions.chats[chatId];
  }
  saveSessions(sessions);
}

function clearProjectSessions(chatId) {
  const sessions = loadSessions();
  if (!sessions.chats) return;
  let changed = false;
  const prefix = `${chatId}::thread:`;
  for (const key of Object.keys(sessions.chats)) {
    if (key === chatId || key.startsWith(prefix)) {
      delete sessions.chats[key];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
}

function recentSessionsForProject(chatId, limit = 5) {
  const sessions = loadSessions();
  const projectId = projectChatId(chatId);
  const prefix = `${projectId}::thread:`;
  const rows = [];
  for (const [contextId, chat] of Object.entries(sessions.chats || {})) {
    if (contextId !== projectId && !contextId.startsWith(prefix)) continue;
    const workspaces = chat && chat.workspaces && typeof chat.workspaces === 'object'
      ? chat.workspaces
      : (chat && chat.sessionId ? { default: chat } : {});
    for (const [workspaceName, entry] of Object.entries(workspaces)) {
      if (!entry || !entry.sessionId) continue;
      rows.push({
        contextId,
        label: contextId === projectId ? '主会话' : contextId.slice(prefix.length) || contextId,
        workspaceName: normalizeWorkspaceName(workspaceName) || 'default',
        sessionId: entry.sessionId,
        cwd: entry.cwd || workspaceForChat(projectId).cwd,
        taskId: entry.taskId || '',
        updatedAt: entry.updatedAt || chat.updatedAt || '',
      });
    }
  }
  return rows
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, clampInt(limit, 1, 10));
}

function sessionEntryForWorkspace(chat, workspaceName) {
  if (!chat || typeof chat !== 'object') return null;
  const normalized = normalizeWorkspaceName(workspaceName) || 'default';
  if (chat.workspaces && typeof chat.workspaces === 'object') return chat.workspaces[normalized] || null;
  if (normalized === 'default' && chat.sessionId) return chat;
  return null;
}

function effectiveRunTimeout(chatId, workspaceName = workspaceForChat(projectChatId(chatId)).name) {
  const sessions = loadSessions();
  const entry = sessionEntryForWorkspace(sessions.chats && sessions.chats[chatId], workspaceName);
  if (entry && entry.timeoutMsOverride === 'off') return { mode: 'off', ms: 0 };
  if (entry && Number.isFinite(Number(entry.timeoutMsOverride))) {
    return { mode: 'session', ms: Number(entry.timeoutMsOverride) };
  }
  const globalMs = effectiveGlobalRunTimeoutMs();
  return globalMs > 0 ? { mode: 'global', ms: globalMs } : { mode: 'off', ms: 0 };
}

function effectiveGlobalRunTimeoutMs() {
  const access = config.accessEnabled ? readAccessFile() : {};
  const value = access.preferences && Number(access.preferences.runTimeoutMs);
  if (Number.isFinite(value)) return Math.max(0, value);
  return Math.max(0, Number(config.codexTimeoutMs || 0));
}

function setSessionTimeoutOverride(chatId, workspaceName, value) {
  const sessions = loadSessions();
  const normalized = normalizeWorkspaceName(workspaceName) || 'default';
  sessions.chats = sessions.chats && typeof sessions.chats === 'object' ? sessions.chats : {};
  const chat = sessions.chats[chatId] && typeof sessions.chats[chatId] === 'object' ? sessions.chats[chatId] : {};
  const workspaces = chat.workspaces && typeof chat.workspaces === 'object' ? chat.workspaces : {};
  const existing = workspaces[normalized] && typeof workspaces[normalized] === 'object' ? workspaces[normalized] : {};
  workspaces[normalized] = {
    ...existing,
    timeoutMsOverride: value,
    updatedAt: new Date().toISOString(),
  };
  sessions.chats[chatId] = {
    ...chat,
    workspaces,
    updatedAt: new Date().toISOString(),
  };
  saveSessions(sessions);
}

function clearSessionTimeoutOverride(chatId, workspaceName) {
  const sessions = loadSessions();
  const normalized = normalizeWorkspaceName(workspaceName) || 'default';
  const entry = sessions.chats && sessions.chats[chatId] && sessions.chats[chatId].workspaces && sessions.chats[chatId].workspaces[normalized];
  if (!entry) return;
  delete entry.timeoutMsOverride;
  entry.updatedAt = new Date().toISOString();
  sessions.chats[chatId].updatedAt = new Date().toISOString();
  saveSessions(sessions);
}

function timeoutStatusText(timeout) {
  if (!timeout || timeout.mode === 'off' || !timeout.ms) return '关闭';
  const minutes = Math.round((timeout.ms / 60000) * 10) / 10;
  return `${minutes} 分钟无响应自动 kill（${timeout.mode === 'session' ? '当前 session 覆盖' : '全局默认'}）`;
}

function loadSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? { chats: parsed.chats || {} } : { chats: {} };
  } catch {
    return { chats: {} };
  }
}

function saveSessions(sessions) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (err) {
    log(`session save failed: ${err.stack || err.message || err}`);
  }
}

function conversationPath(chatId, workspaceName = 'default') {
  const workspaceToken = normalizeWorkspaceName(workspaceName) || 'default';
  const chatToken = safeFileToken(chatId);
  if (workspaceToken === 'default') return path.join(CONVERSATION_DIR, `${chatToken}.json`);
  return path.join(CONVERSATION_DIR, `${chatToken}__${workspaceToken}.json`);
}

function resetProjectConversations(chatId) {
  let files;
  try {
    files = fs.readdirSync(CONVERSATION_DIR);
  } catch {
    return;
  }
  const prefixes = [
    safeFileToken(chatId),
    safeFileToken(`${chatId}::thread:`),
  ];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    if (prefixes.some((prefix) => file.startsWith(prefix))) {
      try {
        fs.rmSync(path.join(CONVERSATION_DIR, file), { force: true });
      } catch (err) {
        log(`project conversation reset failed file=${file}: ${err.stack || err.message || err}`);
      }
    }
  }
}

function safeFileToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function readFinalMessage(task) {
  try {
    return fs.readFileSync(task.outputFile, 'utf8').trim();
  } catch {
    return compactTail(task.output, 4000);
  }
}

function trimFromStart(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `...\n${value.slice(-max)}`;
}

function singleLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function redactSensitiveCommand(text) {
  const value = singleLine(text);
  if (/^\/?account\s+change\s+/i.test(value)) return value.replace(/^(.{0,80}?account\s+change\s+\S+)\s+.+$/i, '$1 ***');
  return value.slice(0, 120);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it.`);
  }
  return value;
}

function homeDir() {
  return process.env.HOME || '/Users/macmini';
}

function maskUrl(url) {
  return url.replace(/\/\/([^:@]+):([^@]+)@/, '//***:***@');
}

function maskSecret(value, head = 6, tail = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= head + tail) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function updateEnvFile(values) {
  const envPath = path.join(ROOT, '.env');
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${shellEnvValue(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text = `${text.replace(/\s*$/, '')}\n${line}\n`;
  }
  fs.writeFileSync(envPath, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
}

function shellEnvValue(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

async function reconnectFeishu() {
  const oldWsClient = wsClient;
  client = createFeishuClient();
  wsClient = createFeishuWsClient();
  try {
    oldWsClient.close({ force: true });
  } catch {}
  await wsClient.start({ eventDispatcher: dispatcher });
  log(`feishu account reconnected app=${maskSecret(config.appId, 8, 4)}`);
}

function formatApiError(err) {
  const status = err && err.response && err.response.status;
  const data = err && err.response && err.response.data;
  const detail = data ? ` response=${JSON.stringify(data).slice(0, 1200)}` : '';
  return `${err && (err.stack || err.message) || err}${status ? ` status=${status}` : ''}${detail}`;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'bridge.log'), `${line}\n`);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  log('shutdown requested');
  for (const task of running.values()) {
    task.killedByUser = true;
    task.child.kill('SIGTERM');
  }
  try {
    wsClient.close({ force: true });
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 300).unref();
}
