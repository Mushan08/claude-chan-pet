#!/usr/bin/env node
/**
 * Claude Code hook -> 桌宠事件桥。
 *
 * Claude Code 会把 hook 事件以 JSON 从 stdin 喂进来，这里只做一件事：
 * 取事件名（外加工具名 / 会话 id）追加一行到 ~/.claude-chan-pet/events.jsonl，
 * 桌宠进程 tail 这个文件。
 *
 * 铁律：hook 绝不能搞坏用户的会话——任何异常都吞掉，永远 exit 0，永远不往 stdout 写东西
 * （写 stdout 会被 Claude Code 当成 hook 的返回值解析）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_DIR = path.join(os.homedir(), '.claude-chan-pet');
const EVENTS_FILE = path.join(HOME_DIR, 'events.jsonl');
const MAX_BYTES = 512 * 1024;
const KEEP_LINES = 200;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      payload = {};
    }
    const record = {
      t: new Date().toISOString(),
      event: payload.hook_event_name || payload.event || 'Unknown',
      session_id: payload.session_id ?? null,
      cwd: payload.cwd ?? null,
      tool_name: payload.tool_name ?? null,
    };
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + '\n', 'utf8');
    trimIfHuge();
  } catch {
    /* 静默：桌宠画不出来也不能影响会话 */
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

function trimIfHuge() {
  try {
    const stat = fs.statSync(EVENTS_FILE);
    if (stat.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(EVENTS_FILE, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
  } catch {
    /* 忽略 */
  }
}