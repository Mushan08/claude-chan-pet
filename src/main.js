/**
 * 主进程：透明悬浮窗 + 运动引擎（漫游 / 拖拽 / 抛掷物理）+ Claude Code 事件桥。
 *
 * 为什么位置归主进程管：桌宠的"走动"和"被甩出去"真正移动的是窗口本身，
 * 渲染层只负责贴图与气泡。这与 dsh-pet 桌面模式"窗口跟随宠物移动"的分工一致。
 */

import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  EVENTS_FILE,
  HOME_DIR,
  loadConfig,
  loadState,
  saveState,
} from './shared/config.js';
import { LINES } from './shared/lines.js';
import { STATES, FACE_LABELS, pickText } from './shared/states.js';

const TICK_MS = 16;
const VELOCITY_CAP = 3600;

// 桌宠是 GUI 应用，控制台看不到东西；关键事件写日志文件，出问题能翻。
const LOG_FILE = path.join(HOME_DIR, 'pet.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* 日志失败不能影响桌宠 */
  }
}

let cfg = loadConfig();
let win = null;
let petBox = { w: Math.round(cfg.pet.height * 0.86), h: cfg.pet.height }; // 宽按正面立绘 392x457 估，收到真实素材后再定死
let petBoxLocked = false;
let currentState = 'idle';
let settleTimer = null;
let whisperTimer = null;

const motion = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  mode: 'idle', // idle | walk | drag | throw
  facing: 1, // 1 = 朝右，-1 = 朝左
  walkTarget: null,
  grab: { dx: 0, dy: 0 },
};

// ---------------------------------------------------------------- 几何

function displayFor(x, y) {
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
}

function workArea() {
  const d = displayFor(motion.x, motion.y);
  return d.workArea;
}

function groundY() {
  const a = workArea();
  return a.y + a.height - (cfg.window.groundOffsetPx || 0);
}

function winSize() {
  return {
    w: Math.round(petBox.w + cfg.window.padX * 2),
    h: Math.round(petBox.h + cfg.window.padTop),
  };
}

function lockWindowSize(size) {
  if (!win || win.isDestroyed()) return;
  try {
    // 锁死尺寸：外部（Aero Snap / Win+方向键 / DPI 变化）就没法把窗口撑大。
    // 窗口一被撑大，宠物就不再贴窗口底部，可放置范围也会被压缩——这是实测踩到的坑。
    win.setMinimumSize(size.w, size.h);
    win.setMaximumSize(size.w, size.h);
  } catch (err) {
    log('lockWindowSize failed: ' + err.message);
  }
}

/** 把窗口尺寸拉回该有的样子。 */
function ensureWindowSize() {
  if (!win || win.isDestroyed()) return;
  const want = winSize();
  const cur = win.getBounds();
  // 2px 容差：Windows 对无边框窗口的实际尺寸常比请求值大 1~2px。
  // 不容忍就会每 2 秒"修正"一次，而"保持底边不动"的算法会把这 1px 误差逐次往下推——
  // 表现就是宠物慢慢沉到站立线以下（实测踩到）。
  if (Math.abs(cur.width - want.w) <= 2 && Math.abs(cur.height - want.h) <= 2) return;
  log(`ensureWindowSize: ${cur.width}x${cur.height} -> ${want.w}x${want.h}`);
  // 保持**底边**不动：立绘贴窗口底部，底边不动就等于宠物帧格原地不变，
  // 这次纠正对用户是"不可见"的。反过来若按顶边缩放，窗口一变大宠物就会往下沉。
  // （2px 容差保证不会像早先那样每 2 秒修正一次、把误差逐次往下推。）
  const bottom = cur.y + cur.height;
  try {
    win.setMaximumSize(100000, 100000); // 先松开上限，否则 setBounds 会被 min/max 卡住
    resizingInternally = true;
    win.setBounds({ width: want.w, height: want.h, y: bottom - want.h });
  } catch (err) {
    log('ensureWindowSize setBounds failed: ' + err.message);
    return;
  } finally {
    resizingInternally = false;
  }
  lockWindowSize(want);
  const b = win.getBounds();
  motion.x = b.x;
  motion.y = b.y;
}

function place(x, y, save = false) {
  // 非有限值绝不能进 setPosition：那会在主进程抛异常直接把桌宠崩掉（实测踩到）
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    log(`place() refused non-finite x=${x} y=${y}; healing to initial spot`);
    const p = initialSpot();
    x = p.x;
    y = p.y;
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.walkTarget = null;
  }
  const p = clampToArea(x, y);
  motion.x = Number.isFinite(p.x) ? p.x : 0;
  motion.y = Number.isFinite(p.y) ? p.y : 0;
  if (win && !win.isDestroyed()) {
    win.setPosition(Math.round(motion.x), Math.round(motion.y));
  }
  if (save) saveState({ x: motion.x, y: motion.y });
}

function clampToArea(x, y) {
  const a = workArea();
  const { w, h } = winSize();
  return {
    x: Math.min(Math.max(x, a.x - cfg.window.padX), a.x + a.width - w + cfg.window.padX),
    y: Math.min(Math.max(y, a.y - cfg.window.padTop), groundY() - h),
  };
}

/** 扫 assets/pet 里的 PNG 头，用最宽的一张定窗口宽度。
 *  只读 PNG 的 IHDR（宽高在固定偏移 16/20），不需要图像库。
 *  用文件真尺寸而不是渲染层上报，少一个可能被改来改去的环节；
 *  表情格（126x106 那种宽扁的）排除在外——它们只出现在气泡里，不该撑宽窗口。 */
function scanSpriteBox() {
  const dir = path.join(import.meta.dirname, '..', 'assets', 'pet');
  let maxAspect = 0; // 从 0 起，日志里的 widest 就能证明扫描真的读到文件了
  let widest = '(none)';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(front|side|back|act-\d+)\.png$/.test(f)) continue;
      const head = Buffer.alloc(24);
      const fd = fs.openSync(path.join(dir, f), 'r');
      try {
        fs.readSync(fd, head, 0, 24, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (head.toString('ascii', 1, 4) !== 'PNG') continue;
      const w = head.readUInt32BE(16);
      const h = head.readUInt32BE(20);
      if (w > 0 && h > 0 && w / h > maxAspect) {
        maxAspect = w / h;
        widest = f;
      }
    }
  } catch (err) {
    log('scanSpriteBox failed: ' + err.message);
  }
  petBox = { w: Math.round(cfg.pet.height * maxAspect), h: cfg.pet.height };
  petBoxLocked = true;
  log(`sprite scan: widest=${widest} aspect=${maxAspect.toFixed(3)} -> petBox ${petBox.w}x${petBox.h}`);
}

let lastInteractive = false;

/** 命中区控制：透明像素点击穿透到下层应用，悬停到立绘上时切成可交互。
 *  渲染层算命中（它知道立绘实际画在哪），这里只执行 + 记日志。 */
ipcMain.on('pet:interactive', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (on === lastInteractive) return;
  lastInteractive = !!on;
  win.setIgnoreMouseEvents(!on, { forward: true });
  log(`interactive ${on ? 'on' : 'off'}`);
});

function initialSpot() {
  const a = screen.getPrimaryDisplay().workArea;
  const { w, h } = winSize();
  return {
    x: a.x + a.width - w - 24,
    y: a.y + a.height - (cfg.window.groundOffsetPx || 0) - h,
  };
}

// ---------------------------------------------------------------- 运动

function startWalk() {
  if (!cfg.wander.enabled || motion.mode !== 'idle') return;
  const a = workArea();
  const dist = cfg.wander.minDist + Math.random() * (cfg.wander.maxDist - cfg.wander.minDist);
  const dir = Math.random() < 0.5 ? -1 : 1;
  const leftEdge = a.x - cfg.window.padX + cfg.wander.margin;
  const rightEdge = a.x + a.width - winSize().w + cfg.window.padX - cfg.wander.margin;
  let target = motion.x + dir * dist;
  if (target < leftEdge || target > rightEdge) target = motion.x - dir * dist;
  target = Math.min(Math.max(target, leftEdge), rightEdge);
  if (Math.abs(target - motion.x) < 12) return;
  motion.mode = 'walk';
  motion.walkTarget = target;
  motion.facing = target > motion.x ? 1 : -1;
  pushMotion(true);
  scheduleWander();
}

function scheduleWander() {
  const { minDelaySec, maxDelaySec } = cfg.wander;
  const delay = (minDelaySec + Math.random() * (maxDelaySec - minDelaySec)) * 1000;
  setTimeout(() => {
    if (motion.mode === 'idle') startWalk();
    else scheduleWander();
  }, delay);
}

// setPosition 是同步的窗口移动，在 Windows 上很贵。走动/飞行时按 30ms 节流，
// 不必跟着 60fps 的物理 tick 一步步挪（那是掉帧的另一来源）。
let lastMoveAt = 0;
/** 我自己 setBounds 时置 true，让 'resized' 日志能区分"我改的"和"别人改的" */
let resizingInternally = false;
function placeThrottled() {
  const now = Date.now();
  if (now - lastMoveAt < 30) return;
  lastMoveAt = now;
  place(motion.x, motion.y);
}

let lastDragAt = 0;

function step(dt) {
  // 拖拽看门狗：指针在窗口外松开时渲染层收不到 mouseup，
  // 宠物会挂在半空不动——超时就当松手，让它按重力落回地面
  if (motion.mode === 'drag' && Date.now() - lastDragAt > 1500) {
    motion.mode = 'throw';
    motion.vx = 0;
    motion.vy = 0;
    pushMotion(true);
  }

  if (motion.mode === 'walk' && motion.walkTarget !== null) {
    const step = cfg.wander.speed * dt * motion.facing;
    motion.x += step;
    if ((motion.facing > 0 && motion.x >= motion.walkTarget) || (motion.facing < 0 && motion.x <= motion.walkTarget)) {
      motion.x = motion.walkTarget;
      motion.walkTarget = null;
      motion.mode = 'idle';
      motion.facing = 1;
      place(motion.x, motion.y);
      pushMotion(true);
      saveState({ x: motion.x, y: motion.y });
    }
    return;
  }

  if (motion.mode === 'throw') {
    const { gravity, restitution, groundFriction, ceilingBounce } = cfg.physics;
    const a = workArea();
    const { w, h } = winSize();
    const minX = a.x - cfg.window.padX;
    const maxX = a.x + a.width - w + cfg.window.padX;
    const floor = groundY() - h;
    const ceil = ceilingBounce ? a.y - cfg.window.padTop : -1e6;

    motion.vy += gravity * dt;
    motion.x += motion.vx * dt;
    motion.y += motion.vy * dt;

    if (motion.x < minX) {
      motion.x = minX;
      motion.vx = Math.abs(motion.vx) * restitution;
      motion.facing = 1;
    } else if (motion.x > maxX) {
      motion.x = maxX;
      motion.vx = -Math.abs(motion.vx) * restitution;
      motion.facing = -1;
    }
    if (motion.y > floor) {
      motion.y = floor;
      motion.vy = -Math.abs(motion.vy) * restitution;
      if (Math.abs(motion.vy) < 90) motion.vy = 0;
    } else if (motion.y < ceil) {
      motion.y = ceil;
      motion.vy = Math.abs(motion.vy) * restitution;
    }

    const onGround = motion.y >= floor - 0.5;
    if (onGround) {
      const decay = Math.exp(-groundFriction * dt);
      motion.vx *= decay;
    }

    if (onGround && Math.abs(motion.vx) < 20 && Math.abs(motion.vy) < 90) {
      motion.vx = 0;
      motion.vy = 0;
      motion.mode = 'idle';
      motion.facing = 1;
      place(motion.x, motion.y);
      pushMotion(true);
      saveState({ x: motion.x, y: motion.y });
      scheduleWander();
      return;
    }
    placeThrottled();
    pushMotion();
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;
  try {
    // 每帧自净：任何一条非有限值都不许活着进 setPosition（那会崩整个主进程）
    if (!Number.isFinite(motion.x) || !Number.isFinite(motion.y)) {
      log(`motion non-finite (x=${motion.x} y=${motion.y}); healing`);
      const p = initialSpot();
      motion.x = p.x;
      motion.y = p.y;
    }
    if (!Number.isFinite(motion.vx)) motion.vx = 0;
    if (!Number.isFinite(motion.vy)) motion.vy = 0;
    if (!Number.isFinite(motion.walkTarget)) motion.walkTarget = null;
    step(dt);
  } catch (err) {
    log('tick error: ' + (err && err.stack ? err.stack : String(err)));
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.walkTarget = null;
  }
}, TICK_MS);

// 兜底：桌宠是常驻小工具，绝不能因为一个未捕获异常弹崩溃框然后消失
process.on('uncaughtException', (err) => {
  log('uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});

let lastPush = 0;
function pushMotion(force = false) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (!force && now - lastPush < 80) return; // 60fps 的物理没必要 60 次/秒 往渲染层灌
  lastPush = now;
  win.webContents.send('pet:motion', {
    vx: motion.vx,
    vy: motion.vy,
    mode: motion.mode,
    facing: motion.facing,
  });
}

// ---------------------------------------------------------------- 状态

function setState(name, extra = {}) {
  const next = STATES[name] ? name : 'idle';
  currentState = next;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:state', {
    state: next,
    pose: STATES[next].pose,
    face: extra.face ?? cfg.stateFaces[next] ?? null,
    text: extra.text ?? pickText(next),
  });
  if (settleTimer) clearTimeout(settleTimer);
  // 有状态变化（要冒气泡）时顺手抬到最前：用户这会儿正要看它
  if (win && !win.isDestroyed() && cfg.window.alwaysOnTop) win.moveTop();
  if (next !== 'idle' && next !== 'sleep' && cfg.work.settleSec > 0) {
    settleTimer = setTimeout(() => setState('idle', { text: null }), cfg.work.settleSec * 1000);
  }
}

function whisperNow() {
  const pool = Array.isArray(cfg.lines) && cfg.lines.length ? cfg.lines : LINES;
  const text = pool[Math.floor(Math.random() * pool.length)];
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:state', {
      state: 'whisper',
      pose: 'front',
      face: cfg.stateFaces.whisper ?? null,
      text,
      transient: true,
    });
  }
  return text;
}

// ---------------------------------------------------------------- 事件桥

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const name = ev.event || ev.hook_event_name;
  if (!name || /^Subagent/.test(ev.subagent ? name : '')) {
    // SubagentStop 归到 result，其余照映射表走
  }
  const mapped = cfg.eventStates[name];
  if (!mapped) return;
  const face = mapped === 'working' && ev.tool_name ? cfg.stateFaces.working : undefined;
  setState(mapped, face ? { face } : {});
}

function startEventTail() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '', 'utf8');
  let offset = fs.statSync(EVENTS_FILE).size; // 只看新事件，不重放历史

  const readNew = () => {
    let stat;
    try {
      stat = fs.statSync(EVENTS_FILE);
    } catch {
      return;
    }
    if (stat.size < offset) offset = 0; // 被清空或轮转
    if (stat.size === offset) return;
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(EVENTS_FILE, 'r');
      fs.readSync(fd, buf, 0, len, offset);
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    offset = stat.size;
    for (const line of buf.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        handleEvent(JSON.parse(t));
      } catch {
        /* 半行或坏行，忽略 */
      }
    }
  };

  try {
    fs.watch(HOME_DIR, (_e, name) => {
      if (!name || name === 'events.jsonl') readNew();
    });
  } catch (err) {
    console.warn('[claude-chan-pet] fs.watch 不可用，改纯轮询：', err.message);
  }
  setInterval(readNew, 2000); // Windows 上 fs.watch 偶尔漏事件，兜底
  readNew();
}

function startWhisper() {
  if (whisperTimer) clearInterval(whisperTimer);
  if (!cfg.whisper.enabled) return;
  whisperTimer = setInterval(whisperNow, Math.max(20, cfg.whisper.intervalSec) * 1000);
}

// ---------------------------------------------------------------- 菜单

function popupMenu() {
  const faces = Array.from({ length: 10 }, (_, i) => i + 1);
  const clipItem = (label, name) => ({
    label,
    click: () => win && !win.isDestroyed() && win.webContents.send('pet:play-clip', name),
  });
  const template = [
    { label: '碎碎念一句', click: () => whisperNow() },
    {
      label: '换个表情',
      submenu: faces.map((n) => ({
        label: `表情 ${n} · ${FACE_LABELS[n - 1] ?? ''}`.trim(),
        click: () => setState(currentState, { face: n, text: null }),
      })),
    },
    {
      label: '动作',
      submenu: [
        clipItem('抱玩偶', 'hug'),
        clipItem('招手', 'wave'),
        clipItem('比心', 'love'),
        clipItem('看书', 'read'),
      ],
    },
    { type: 'separator' },
    {
      label: '回到初始位置',
      click: () => {
        const p = initialSpot();
        motion.mode = 'idle';
        motion.walkTarget = null;
        place(p.x, p.y, true);
      },
    },
    {
      label: '重载配置',
      click: () => {
        cfg = loadConfig();
        startWhisper();
        setState('idle', { text: '配置已重载。' });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

// ---------------------------------------------------------------- 窗口

/** 自检：不依赖用户桌面，让窗口自己截图自己。
 *  两张图分别验两件事——①立绘能画出来；②hook → 事件文件 → tail → 状态 → 渲染 整条链通。 */
async function runSelfTest() {
  const outDir = path.join(import.meta.dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    try {
      const img = await win.capturePage();
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log(`[selftest] ${file}  ${img.getSize().width}x${img.getSize().height}`);
    } catch (err) {
      console.error('[selftest] capturePage failed:', err.message);
    }
  };

  startEventTail();
  await sleep(1500);
  await shot('selftest-idle');

  // 真跑一遍 hook：往它的 stdin 喂一个 PreToolUse 事件，看宠物会不会自己进入 working
  const { spawnSync } = await import('node:child_process');
  const hookFile = path.join(import.meta.dirname, '..', 'hooks', 'claude-chan-pet-hook.mjs');
  const res = spawnSync(process.env.CLAUDE_CHAN_PET_NODE || 'node', [hookFile], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'selftest',
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
  });
  console.log(
    `[selftest] hook exit=${res.status} stdout=${JSON.stringify(res.stdout ?? '')} err=${res.stderr || ''}`,
  );

  await sleep(1600);
  await shot('selftest-state');

  // 右键「换个表情」走的就是这条路：text 为 null、只有 face。
  // 之前渲染层 `if (text)` 直接 hideBubble，表情永远不出现，所以单独留一张回归图。
  setState('idle', { face: 1, text: null });
  await sleep(700);
  await shot('selftest-face');

  // 动作片段：success 走 love 那段，播到一半截图
  setState('success', {});
  await sleep(1200);
  await shot('selftest-clip');

  app.quit();
}

async function createWindow() {
  const saved = loadState();
  const spot = initialSpot();
  // 只恢复横向位置：纵坐标一律回到"站在地面"，
  // 免得上次异常退出（或拖拽没收到 mouseup）留下的半空坐标被复现
  scanSpriteBox();
  motion.x = Number.isFinite(saved.x) ? saved.x : spot.x;
  motion.y = spot.y;
  const { w, h } = winSize();

  win = new BrowserWindow({
    x: Math.round(motion.x),
    y: Math.round(motion.y),
    width: w,
    height: h,
    frame: false,
    transparent: cfg.pet.transparent,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: cfg.window.alwaysOnTop,
    opacity: cfg.pet.opacity,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  if (cfg.window.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  // 三重锁：不允许缩放/最大化/最小化。实测拖窗口边缘会把窗口拉大，
  // 而窗口一变大，宠物就不再贴窗口底部——可放置范围被压缩、站立线也会算错。
  win.setResizable(false);
  win.setMaximizable(false);
  win.setMinimizable(false);
  // min=max 也挡不住鼠标抓边框改尺寸（实测日志里窗口被拉到 343x412 过），
  // 所以在 will-resize 里直接拒掉，这是最后一道。
  win.on('will-resize', (event) => {
    event.preventDefault();
    log('will-resize blocked');
  });
  // 诊断：窗口尺寸被改时记录是谁改的。我自己只会通过 setBounds 改，
  // 所以只要出现"没经过 ensureWindowSize 的 resized"，就是外部在动它。
  win.on('resized', () => {
    const b = win.getBounds();
    log(`resized -> ${b.width}x${b.height} (internal=${resizingInternally})`);
    if (!resizingInternally) {
      // 被外部或 Chromium 改过尺寸时，**置顶会丢**。丢了桌宠就掉到别的窗口下面
      // （实测用户看到 Claude 应用的文字压在角色上面）。所以这里必须立刻重申，
      // 只靠那个 5 秒的 flag 重申抢不过。
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
  });
  // 透明窗口里，非宠物身体的部分要点击穿透到下层应用；渲染层按悬停命中翻回来
  win.setIgnoreMouseEvents(true, { forward: true });
  await win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
  const b = win.getBounds();
  log(`window created ${b.width}x${b.height} at ${b.x},${b.y} (workArea ${JSON.stringify(workArea())})`);
  lockWindowSize(winSize());
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.on('pet:sprite-size', (_e, { w, h }) => {
  // 窗口尺寸现在由主进程扫 PNG 头决定（scanSpriteBox），这里只留一行日志做对照
  log(`renderer reports sprite ${w}x${h} (window size comes from scanSpriteBox)`);
});

ipcMain.on('pet:drag-start', (_e, payload = {}) => {
  const { screenX, screenY } = payload;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    log(`drag-start ignored: bad payload ${JSON.stringify(payload)}`);
    return;
  }
  motion.mode = 'drag';
  motion.walkTarget = null;
  motion.grab = { dx: motion.x - screenX, dy: motion.y - screenY };
  lastDragAt = Date.now();
  log(`drag-start cursor=${Math.round(screenX)},${Math.round(screenY)} win=${Math.round(motion.x)},${Math.round(motion.y)}`);
});

ipcMain.on('pet:drag-move', (_e, payload = {}) => {
  const { screenX, screenY } = payload;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (motion.mode !== 'drag') {
    // drag-start 没到就地补一个：实测出过"drag-end 一直有、drag-start 一条都没有"
    // 的情况（渲染层在两者之间抛了异常）。用第一个 drag-move 的坐标 + 当前窗口位置
    // 反推 grab 偏移，与正常的 drag-start 完全等价，不再依赖那条消息。
    motion.mode = 'drag';
    motion.walkTarget = null;
    motion.grab = { dx: motion.x - screenX, dy: motion.y - screenY };
    log(`drag-start (inferred from drag-move) cursor=${Math.round(screenX)},${Math.round(screenY)}`);
  }
  lastDragAt = Date.now();
  place(screenX + motion.grab.dx, screenY + motion.grab.dy);
});

ipcMain.on('pet:drag-end', (_e, payload = {}) => {
  log(`drag-end mode=${motion.mode} v=${Math.round(payload.vx || 0)},${Math.round(payload.vy || 0)}`);
  if (motion.mode !== 'drag') return;
  const vx = Number.isFinite(payload.vx) ? payload.vx : 0;
  const vy = Number.isFinite(payload.vy) ? payload.vy : 0;
  const speed = Math.hypot(vx, vy);
  if (speed < (cfg.physics.dropThresholdPx ?? 140)) {
    // 温柔放下：原地停住，不启动重力。
    // 这一条是把宠物放到桌面任意位置的前提——否则每次松手都被重力拽回底线。
    motion.mode = 'idle';
    motion.vx = 0;
    motion.vy = 0;
    motion.facing = 1;
    pushMotion(true);
    saveState({ x: motion.x, y: motion.y });
    scheduleWander();
    log(`drop in place at ${Math.round(motion.x)},${Math.round(motion.y)} (speed ${Math.round(speed)})`);
    return;
  }
  const p = cfg.physics.throwPower ?? 1;
  const cap = (v) => Math.max(-VELOCITY_CAP, Math.min(VELOCITY_CAP, v * p));
  motion.vx = cap(vx);
  motion.vy = cap(vy);
  motion.mode = 'throw';
  motion.vx !== 0 && (motion.facing = motion.vx > 0 ? 1 : -1);
  pushMotion(true);
  log(`throw v=${Math.round(vx)},${Math.round(vy)}`);
});

ipcMain.on('pet:menu', () => popupMenu());
ipcMain.on('pet:frames', (_e, stats) => {
  log(
    `frames[${stats.label}] n=${stats.frames} p50=${stats.p50}ms p95=${stats.p95}ms worst=${stats.worst}ms over32ms=${stats.over32}`,
  );
});
ipcMain.handle('pet:whisper', () => whisperNow());
function loadClips() {
  // 动作片段由 scripts/make-emote-clips.py 生成，manifest 不存在就当作没有
  try {
    const file = path.join(import.meta.dirname, '..', 'assets', 'pet', 'anims', 'manifest.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).clips ?? {};
  } catch {
    return {};
  }
}

ipcMain.handle('pet:config', () => ({
  petHeight: cfg.pet.height,
  whisperEnabled: cfg.whisper.enabled,
  clips: loadClips(),
}));

app.whenReady().then(async () => {
  const selfTest = process.argv.includes('--selftest');
  if (!selfTest && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => win && win.focus());
  await createWindow();
  if (selfTest) {
    await runSelfTest();
    return;
  }
  startEventTail();
  startWhisper();
  scheduleWander();
  if (cfg.window.alwaysOnTop && cfg.window.topmostWatchdog) {
    setInterval(() => {
      if (!win || win.isDestroyed()) return;
      ensureWindowSize();
      // 必须带 moveTop()：实测窗口被改尺寸时**置顶会丢**，而那次改尺寸连 Electron 的
      // 'resized' 事件都不触发（所以不能只挂在事件上）。只重申 flag 不够，得真的抬 z 序。
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }, 8000);
  }
  screen.on('display-metrics-changed', () => place(motion.x, motion.y, true));
});

app.on('window-all-closed', () => app.quit());
