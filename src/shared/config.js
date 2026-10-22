/**
 * 配置：内置默认 + 用户层覆盖（~/.claude-chan-pet/config.json）。
 * 顶层字段整段替换，缺的子键不回补——与 dsh-pet 的合并口径一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.claude-chan-pet');
export const EVENTS_FILE = path.join(HOME_DIR, 'events.jsonl');
export const STATE_FILE = path.join(HOME_DIR, 'state.json');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

export const DEFAULTS = {
  pet: {
    // 立绘显示**高度**（px）。基准取高度而不是宽度：正面/侧面/背面三张素材等高但宽窄不同，
    // 按宽度对齐会导致换姿势时宠物忽胖忽瘦、窗口跟着改尺寸。
    height: 233,
    opacity: 1,
    // 真透明悬浮窗。素材已抠成 alpha PNG，默认 true。
    transparent: true,
  },
  window: {
    // 宠物四周留白（给气泡和阴影）
    padX: 40,
    padTop: 110,
    alwaysOnTop: true,
    // Windows 上置顶会被别的全屏/置顶窗顶掉，定期重申一次（dsh-pet 也有一个 topmost watchdog）
    topmostWatchdog: true,
    // 站立基准线相对工作区底边的偏移（px，正数 = 抬高）。用来避开任务栏上沿那条缝。
    groundOffsetPx: 0,
  },
  physics: {
    gravity: 1400,
    restitution: 0.78,
    groundFriction: 2.5,
    ceilingBounce: true,
    throwPower: 1.0,
    // 松手速度低于这个值就算"温柔放下"：原地停住，不启动重力（这样才能把宠物放在桌面任意位置）
    dropThresholdPx: 140,
  },
  wander: {
    // 默认关闭：用户实测"老是自己水平移动乱动"，很烦。要她溜达就改成 true。
    enabled: false,
    minDelaySec: 20,
    maxDelaySec: 60,
    minDist: 60,
    maxDist: 240,
    margin: 20,
    speed: 90,
  },
  work: {
    // 状态自动回 idle 的秒数（0 = 不回）
    settleSec: 9,
  },
  whisper: {
    enabled: true,
    intervalSec: 25,
    minSec: 20,
    maxSec: 30,
  },
  // 事件名 → 宠物状态。改这里就能改映射，不用动代码。
  eventStates: {
    SessionStart: 'idle',
    UserPromptSubmit: 'thinking',
    PreToolUse: 'working',
    PostToolUse: 'result',
    PostToolUseFailure: 'error',
    Notification: 'waiting',
    Stop: 'success',
    SubagentStop: 'result',
    PreCompact: 'thinking',
    SessionEnd: 'idle',
  },
  // 状态 → 表情格（assets/pet/face-NN.png），null = 只用立绘
  stateFaces: {
    thinking: 7,
    working: 3,
    result: 2,
    waiting: 4,
    success: 1,
    error: 6,
    sleep: 9,
    whisper: 10,
  },
  lines: null, // null = 用内置台词池
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[claude-chan-pet] 配置读取失败，改用内置默认：', err.message);
    }
  }
  const cfg = merge(DEFAULTS, user);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  return cfg;
}

export function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[claude-chan-pet] 位置保存失败：', err.message);
  }
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
