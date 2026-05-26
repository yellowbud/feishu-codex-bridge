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
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspaces.json');
const APPROVED_DIR = path.join(DATA_DIR, 'approved');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(CONVERSATION_DIR, { recursive: true });

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
  streamOutput: process.env.FEISHU_STREAM_OUTPUT === '1',
};

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const clientConfig = {
  appId: config.appId,
  appSecret: config.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
  ...(proxyAgent ? { agent: proxyAgent } : {}),
};

const client = new Lark.Client(clientConfig);
const wsClient = new Lark.WSClient({
  ...clientConfig,
  loggerLevel: Lark.LoggerLevel.info,
  autoReconnect: true,
  handshakeTimeoutMs: 30000,
  source: 'feishu-codex-bridge',
  onReady: () => log('feishu websocket connected'),
  onReconnecting: () => log('feishu websocket reconnecting'),
  onReconnected: () => log('feishu websocket reconnected'),
  onError: (err) => log(`feishu websocket error: ${err.stack || err.message || err}`),
});

const running = new Map();
let taskSeq = 0;

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
  const text = extractText(message);
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const senderId = data.sender && data.sender.sender_id && (data.sender.sender_id.open_id || data.sender.sender_id.user_id);

  if (!chatId || !messageId || !text || !senderId) return;
  log(`message received chat=${chatId} type=${chatType || 'unknown'} sender=${senderId} mentions=${mentions.length} text=${singleLine(text).slice(0, 120)}`);
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

  if (messageType !== 'text') {
    await sendUiMessage(chatId, {
      kind: 'error',
      title: '不支持的消息类型',
      template: 'red',
      summary: `当前消息类型：${messageType || 'unknown'}`,
      body: '目前仅支持文本指令。',
    }, messageId);
    return;
  }

  const command = parseCommand(text);
  if (!command) return;

  if (command.kind === 'help') {
    await sendHelp(chatId, messageId);
    return;
  }
  if (command.kind === 'status') {
    await sendStatus(chatId, messageId);
    return;
  }
  if (command.kind === 'reset') {
    resetConversation(chatId);
    await sendUiMessage(chatId, {
      kind: 'success',
      title: '上下文已清空',
      template: 'green',
      summary: '当前飞书会话的上下文记忆已重置。',
    }, messageId);
    return;
  }
  if (command.kind === 'cd') {
    await handleCd(chatId, command.target, messageId);
    return;
  }
  if (command.kind === 'stop') {
    await cancelChatTasks(chatId, messageId);
    return;
  }
  if (command.kind === 'cancel') {
    await cancelTask(command.taskId, chatId, messageId);
    return;
  }
  if (command.kind === 'run') {
    await startCodexTask(command.prompt, {
      chatId,
      messageId,
      senderId,
      useMemory: command.useMemory,
      memoryReason: command.memoryReason,
    });
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
  if (exactCommand && ['new', 'reset', 'clear', 'forget', '清空上下文', '清空记忆', '忘记'].includes(commandLower)) {
    return { kind: 'reset' };
  }
  if (exactCommand && ['stop', '停止', '中止'].includes(commandLower)) {
    return { kind: 'stop' };
  }
  if (commandWithArgsAllowed && ['cancel', '取消'].includes(commandLower)) {
    const [taskId] = commandArgs;
    return { kind: 'cancel', taskId };
  }
  if (commandWithArgsAllowed && commandLower === 'cd') return { kind: 'cd', target: commandArgs.join(' ') };

  const memoryHint = memoryHintForPrompt(body);
  return {
    kind: 'run',
    prompt: memoryHint.prompt,
    useMemory: memoryHint.useMemory,
    memoryReason: memoryHint.reason,
  };
}

function memoryHintForPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return { prompt: text, useMemory: false, reason: 'empty' };

  const forceNew = text.match(/^(新任务|新的任务|开始新任务|另起一个任务|不要带上下文|不带上下文|忽略上文|忘记上文)[:：\s]+(.+)$/s);
  if (forceNew) return { prompt: forceNew[2].trim(), useMemory: false, reason: 'force-new' };

  const forceContinue = text.match(/^(继续|接着|基于上文|基于以上|根据上文|根据以上|参考上文|参考以上|延续上文|延续以上)[:：\s]*(.*)$/s);
  if (forceContinue) {
    const cleaned = forceContinue[2].trim();
    return { prompt: cleaned || text, useMemory: true, reason: forceContinue[1] };
  }

  return {
    prompt: text,
    useMemory: config.memoryMode === 'always',
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

async function handleCd(chatId, target, replyToMessageId) {
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
  resetConversation(chatId);
  await sendUiMessage(chatId, {
    kind: 'success',
    title: '工作目录已切换',
    template: 'green',
    summary: `**当前目录**：${resolved.path}`,
    body: '已同时清空当前飞书会话的上下文，避免新项目串到旧任务。',
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
  if (running.size >= config.maxConcurrentTasks) {
    await sendUiMessage(
      source.chatId,
      {
        kind: 'busy',
        title: '任务队列已满',
        template: 'orange',
        summary: `当前已有 ${running.size} 个任务运行中。`,
        body: `查看状态：\`${config.commandPrefix} status\`\n取消任务：\`${config.commandPrefix} cancel <taskId>\``,
      },
      source.messageId,
    );
    return;
  }

  const taskId = `codex-${Date.now()}-${++taskSeq}`;
  const startedAt = Date.now();
  const outputFile = path.join(DATA_DIR, `${taskId}.last-message.txt`);
  const codexPrompt = buildPromptWithMemory(source.chatId, prompt, source.useMemory);
  const cwd = cwdForChat(source.chatId);
  const args = ['exec', ...config.codexExtraArgs];
  if (config.codexModel) args.push('-m', config.codexModel);
  args.push('-o', outputFile, '-C', cwd, codexPrompt);

  await sendTaskStarted(source.chatId, {
    taskId,
    cwd,
    useMemory: source.useMemory,
    memoryReason: source.memoryReason,
  }, source.messageId);
  log(`task ${taskId} start from=${source.senderId || 'unknown'} chat=${source.chatId} cwd=${cwd} memory=${source.useMemory ? source.memoryReason : 'new'} prompt=${singleLine(prompt).slice(0, 500)}`);

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
    messageId: source.messageId,
    startedAt,
    output: '',
    stderr: '',
    buffer: '',
    userPrompt: prompt,
    outputFile,
    cwd,
    timer: null,
    killedByUser: false,
  };
  running.set(taskId, task);

  const timeout = setTimeout(() => {
    task.killedByUser = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, config.codexTimeoutMs);
  timeout.unref();

  child.stdout.on('data', (chunk) => appendOutput(task, chunk.toString(), false));
  child.stderr.on('data', (chunk) => appendOutput(task, chunk.toString(), true));
  child.on('error', async (err) => {
    clearTimeout(timeout);
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
    clearTimeout(timeout);
    running.delete(taskId);
    await flushTaskBuffer(task);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const tail = compactTail(task.output || task.stderr, 3000);
    const verdict = code === 0 && !signal ? '完成' : (task.killedByUser ? '已取消/超时' : '失败');
    const finalMessage = readFinalMessage(task);
    if (code === 0 && !signal && finalMessage) {
      appendConversationTurn(source.chatId, task.userPrompt, finalMessage);
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

async function flushTaskBuffer(task) {
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = null;
  }

  const buffered = task.buffer;
  task.buffer = '';
  if (!buffered.trim() || !config.streamOutput) return;

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
  const tasks = Array.from(running.values()).filter((task) => task.chatId === chatId);
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
    title: '已请求停止当前会话任务',
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
    `**工作目录**：${task.cwd}`,
    `**上下文**：${task.useMemory ? `继续模式（${task.memoryReason || 'explicit'}）` : '新任务隔离'}`,
  ].join('\n');
  await sendCard(chatId, {
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Codex 已接收' },
    },
    elements: cardElements([
      { tag: 'markdown', content: `任务已开始，完成后会直接返回结果。\n\n${details}` },
    ]),
  }, `Codex 已接收\n${details}`, replyToMessageId);
}

async function sendTaskFinished(chatId, task, replyToMessageId) {
  const success = task.verdict === '完成';
  const cancelled = task.verdict === '已取消/超时';
  const template = success ? 'green' : (cancelled ? 'orange' : 'red');
  const resultText = task.finalMessage || task.tail || '无输出。';
  const title = `Codex 任务${task.verdict}`;
  const meta = [
    `**任务 ID**：${task.taskId}`,
    `**耗时**：${formatDuration(task.elapsed)}`,
    success ? null : `**退出码**：${task.code ?? 'n/a'}`,
    success || !task.signal ? null : `**信号**：${task.signal}`,
  ].filter(Boolean).join('\n');

  for (const [index, chunk] of chunkText(resultText, 2800, 'newline').entries()) {
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
    }, `${title}\n${meta}\n\n${resultText}`, replyToMessageId);
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

async function sendStatus(chatId, replyToMessageId) {
  const fields = [];
  if (!running.size) {
    fields.push('**运行中任务**：0');
  } else {
    fields.push(`**运行中任务**：${running.size}`);
    for (const task of running.values()) {
      const sameChat = task.chatId === chatId ? '当前会话' : '其他会话';
      fields.push(`- ${task.id}，${sameChat}，已运行 ${formatDuration(Math.round((Date.now() - task.startedAt) / 1000))}`);
    }
  }
  fields.push(`**当前会话工作目录**：${cwdForChat(chatId)}`);
  fields.push(`**默认工作目录**：${config.codexCwd}`);
  fields.push(`**上下文记忆**：${memoryStatusText()}`);
  await sendCard(chatId, {
    header: {
      template: running.size ? 'orange' : 'green',
      title: { tag: 'plain_text', content: 'Feishu Codex Bridge 状态' },
    },
    elements: cardElements([{ tag: 'markdown', content: fields.join('\n') }]),
  }, statusText(chatId), replyToMessageId);
}

async function sendHelp(chatId, replyToMessageId) {
  const commands = [
    '`/help` 查看帮助',
    '`/status` 查看状态',
    '`/new` 开始新任务并清空当前会话上下文',
    '`/stop` 停止当前飞书会话的运行中任务',
    '`/cancel <taskId>` 按任务 ID 取消',
    '`/cd <目录>` 切换当前飞书会话的工作目录',
    '直接发送需求即可执行任务；已授权群聊无需 @机器人。',
  ];
  await sendCard(chatId, {
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Feishu Codex Bridge' },
    },
    elements: cardElements([
      { tag: 'markdown', content: commands.join('\n') },
      { tag: 'markdown', content: `**当前会话工作目录**：${cwdForChat(chatId)}\n${conversationStatusText()}` },
      { tag: 'markdown', content: `**上下文用法**\n默认每条消息都是新任务，不带旧上下文。\n需要继续旧任务时，以 \`继续\`、\`接着\`、\`基于上文\` 开头。\n强制新任务可用 \`新任务：...\`。` },
    ]),
  }, helpText(chatId), replyToMessageId);
}

async function sendCard(chatId, card, fallbackText, replyToMessageId) {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
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
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
    } catch (err) {
      log(`send message failed replyTo=${replyToMessageId || 'n/a'}: ${formatApiError(err)}`);
    }

    if (config.webhookUrl && config.webhookMirror) {
      await sendWebhookText(chunk);
    }
  }
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

function extractText(message) {
  try {
    const parsed = JSON.parse(message.content || '{}');
    return String(parsed.text || '').trim();
  } catch {
    return '';
  }
}

function stripMention(text) {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/gi, '')
    .replace(/@\S+\s*/g, '')
    .trim();
}

function statusText(chatId) {
  if (!running.size) return `当前没有运行中的 Codex 任务。桥接服务在线。\n当前会话工作目录：${cwdForChat(chatId)}\n${conversationStatusText()}`;
  const lines = ['运行中的任务：'];
  for (const task of running.values()) {
    lines.push(`- ${task.id}，已运行 ${Math.round((Date.now() - task.startedAt) / 1000)}s`);
  }
  lines.push(`当前会话工作目录：${cwdForChat(chatId)}`);
  lines.push(conversationStatusText());
  return lines.join('\n');
}

function conversationStatusText() {
  if (!config.memoryEnabled) return '上下文记忆：关闭';
  return `上下文记忆：${memoryStatusText()}`;
}

function memoryStatusText() {
  if (!config.memoryEnabled) return '关闭';
  if (config.memoryMode === 'always') {
    return `总是携带，最多保留 ${config.memoryMaxTurns} 轮 / ${config.memoryMaxChars} 字符`;
  }
  return `显式继续时携带最近 ${config.memoryContextTurns} 轮；默认新任务隔离`;
}

function helpText(chatId) {
  return [
    'Feishu Codex Bridge 在线。',
    '',
    '执行任务：直接发送需求',
    '查看状态：/status',
    '新任务：/new',
    '停止当前会话任务：/stop',
    '取消指定任务：/cancel <taskId>',
    '切换目录：/cd <目录>',
    '',
    `当前会话工作目录：${cwdForChat(chatId)}`,
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

function buildPromptWithMemory(chatId, prompt, useMemory) {
  if (!config.memoryEnabled) return prompt;
  if (!useMemory) return prompt;
  const conversation = loadConversation(chatId);
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

function appendConversationTurn(chatId, userPrompt, assistantMessage) {
  if (!config.memoryEnabled) return;
  const conversation = loadConversation(chatId);
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  turns.push({
    at: new Date().toISOString(),
    user: trimFromStart(String(userPrompt || '').trim(), 2000),
    assistant: trimFromStart(String(assistantMessage || '').trim(), 4000),
  });

  conversation.chatId = chatId;
  conversation.updatedAt = new Date().toISOString();
  conversation.turns = trimConversation(turns);
  saveConversation(chatId, conversation);
}

function trimConversation(turns) {
  let kept = turns.slice(-Math.max(1, config.memoryMaxTurns));
  while (JSON.stringify(kept).length > config.memoryMaxChars && kept.length > 1) {
    kept = kept.slice(1);
  }
  return kept;
}

function loadConversation(chatId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(conversationPath(chatId), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { turns: [] };
  } catch {
    return { turns: [] };
  }
}

function saveConversation(chatId, conversation) {
  try {
    fs.writeFileSync(conversationPath(chatId), `${JSON.stringify(conversation, null, 2)}\n`);
  } catch (err) {
    log(`conversation save failed chat=${chatId}: ${err.stack || err.message || err}`);
  }
}

function resetConversation(chatId) {
  try {
    fs.rmSync(conversationPath(chatId), { force: true });
  } catch (err) {
    log(`conversation reset failed chat=${chatId}: ${err.stack || err.message || err}`);
  }
}

function cwdForChat(chatId) {
  const workspaces = loadWorkspaces();
  const cwd = workspaces.chats && workspaces.chats[chatId] && workspaces.chats[chatId].cwd;
  return cwd || config.codexCwd;
}

function setChatCwd(chatId, cwd) {
  const workspaces = loadWorkspaces();
  workspaces.chats = workspaces.chats && typeof workspaces.chats === 'object' ? workspaces.chats : {};
  workspaces.chats[chatId] = {
    cwd,
    updatedAt: new Date().toISOString(),
  };
  saveWorkspaces(workspaces);
}

function loadWorkspaces() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? { chats: parsed.chats || {} } : { chats: {} };
  } catch {
    return { chats: {} };
  }
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

function conversationPath(chatId) {
  return path.join(CONVERSATION_DIR, `${safeFileToken(chatId)}.json`);
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
