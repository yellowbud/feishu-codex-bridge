#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');
const APPROVED_DIR = path.join(DATA_DIR, 'approved');

const args = process.argv.slice(2);
const command = args[0] || 'status';

function defaultAccess() {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} };
}

function readAccess() {
  try {
    return { ...defaultAccess(), ...JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')) };
  } catch {
    return defaultAccess();
  }
}

function writeAccess(access) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ACCESS_FILE, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function status() {
  const access = readAccess();
  console.log(`dmPolicy: ${access.dmPolicy}`);
  console.log(`allowFrom (${access.allowFrom.length}): ${access.allowFrom.join(', ') || '(none)'}`);
  console.log(`groups (${Object.keys(access.groups || {}).length}): ${Object.keys(access.groups || {}).join(', ') || '(none)'}`);
  const pending = Object.entries(access.pending || {});
  console.log(`pending (${pending.length}):`);
  for (const [code, entry] of pending) {
    const age = Math.round((Date.now() - Number(entry.createdAt || 0)) / 1000);
    console.log(`- ${code} sender=${entry.senderId} chat=${entry.chatId} age=${age}s`);
  }
}

if (command === 'status') {
  status();
} else if (command === 'pair') {
  const code = args[1];
  const access = readAccess();
  const pending = access.pending && access.pending[code];
  if (!pending || Number(pending.expiresAt || 0) < Date.now()) {
    console.error(`No active pairing for code: ${code || '(missing)'}`);
    process.exit(1);
  }
  access.allowFrom = dedupe([...(access.allowFrom || []), pending.senderId]);
  delete access.pending[code];
  writeAccess(access);
  fs.mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(APPROVED_DIR, pending.senderId), String(pending.chatId || ''), { mode: 0o600 });
  console.log(`Paired sender: ${pending.senderId}`);
} else if (command === 'deny') {
  const code = args[1];
  const access = readAccess();
  if (access.pending) delete access.pending[code];
  writeAccess(access);
  console.log(`Denied pairing: ${code}`);
} else if (command === 'allow') {
  const senderId = args[1];
  if (!senderId) throw new Error('Usage: npm run access -- allow <senderId>');
  const access = readAccess();
  access.allowFrom = dedupe([...(access.allowFrom || []), senderId]);
  writeAccess(access);
  console.log(`Allowed sender: ${senderId}`);
} else if (command === 'remove') {
  const senderId = args[1];
  const access = readAccess();
  access.allowFrom = (access.allowFrom || []).filter((value) => value !== senderId);
  writeAccess(access);
  console.log(`Removed sender: ${senderId}`);
} else if (command === 'policy') {
  const mode = args[1];
  if (!['pairing', 'allowlist', 'disabled'].includes(mode)) {
    throw new Error('Usage: npm run access -- policy <pairing|allowlist|disabled>');
  }
  const access = readAccess();
  access.dmPolicy = mode;
  writeAccess(access);
  console.log(`dmPolicy set to: ${mode}`);
} else if (command === 'group') {
  const action = args[1];
  const chatId = args[2];
  const access = readAccess();
  access.groups = access.groups || {};
  if (action === 'add') {
    if (!chatId) throw new Error('Usage: npm run access -- group add <chatId> [--no-mention] [--allow id1,id2]');
    const allowFlag = args.find((arg) => arg.startsWith('--allow='));
    access.groups[chatId] = {
      requireMention: !args.includes('--no-mention'),
      allowFrom: allowFlag ? allowFlag.slice('--allow='.length).split(',').map((item) => item.trim()).filter(Boolean) : [],
    };
    writeAccess(access);
    console.log(`Added group: ${chatId}`);
  } else if (action === 'rm') {
    delete access.groups[chatId];
    writeAccess(access);
    console.log(`Removed group: ${chatId}`);
  } else {
    throw new Error('Usage: npm run access -- group <add|rm> ...');
  }
} else if (command === 'set') {
  const key = args[1];
  const value = args.slice(2).join(' ');
  const access = readAccess();
  if (key === 'textChunkLimit') access.textChunkLimit = Number(value);
  else if (key === 'chunkMode') {
    if (!['length', 'newline'].includes(value)) throw new Error('chunkMode must be length or newline');
    access.chunkMode = value;
  } else if (key === 'mentionPatterns') {
    access.mentionPatterns = JSON.parse(value);
    if (!Array.isArray(access.mentionPatterns)) throw new Error('mentionPatterns must be a JSON array');
  } else {
    throw new Error('Supported keys: textChunkLimit, chunkMode, mentionPatterns');
  }
  writeAccess(access);
  console.log(`Set ${key}`);
} else {
  status();
}
