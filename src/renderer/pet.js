/**
 * 渲染层：立绘、表情气泡、Q 弹 / 拖拽 / 甩抛的视觉表现。
 * 窗口位置由主进程管，这里只做"贴图 + 形变"。
 */

import { CLICK_LINES } from '../shared/lines.js';

const SPRITES = {
  front: '../../assets/pet/front.png',
  side: '../../assets/pet/side.png',
  back: '../../assets/pet/back.png',
};
const facePath = (n) => `../../assets/pet/face-${String(n).padStart(2, '0')}.png`;

const stage = document.getElementById('stage');
const petEl = document.getElementById('pet');
const animEl = document.getElementById('anim');
const body = document.getElementById('body');
const bubble = document.getElementById('bubble');
const bubbleFace = document.getElementById('bubble-face');
const bubbleText = document.getElementById('bubble-text');

const view = {
  facing: 1,
  sy: 1, // 垂直缩放，1 = 原始。**由阻尼弹簧驱动** → 天然带回弹过冲，这就是 Q 弹
  syV: 0,
  sx: 1, // 横向缩放由 sy 按"体积守恒"推出来，才是挤压拉伸而不是单纯压扁
  tilt: 0,
  tiltTarget: 0,
  lagX: 0, // 拖拽时立绘相对窗口的滞后（窗口是刚性跟手的，弹性做成视觉滞后）
  lagY: 0,
  lagVX: 0,
  lagVY: 0,
  dragging: false,
  lastThrowVy: 0,
};

// 劲度 / 阻尼：偏欠阻尼（ζ≈0.29）——过冲约 16%、来回晃两三下才停，这才是 Q 弹。
// 之前 C=15（ζ=0.41）只过冲 9.6%、0.11s 就定住，手感是"啪一下"。
const SQUASH_K = 300;
const SQUASH_C = 10;
const LAG_K = 260;
const LAG_C = 18;
const VOLUME_EXP = 0.45; // sx = sy ** -0.45
let lastFrameAt = 0;

body.src = SPRITES.front;
let reportedSize = false;
body.addEventListener('load', () => {
  // 只上报一次：这份尺寸用来定窗口（以正面立绘为基准），换姿势时不再上报，
  // 否则侧视图/背视图的不同宽高比会把窗口改来改去。
  if (reportedSize) return;
  reportedSize = true;
  window.pet.setSpriteSize(body.naturalWidth, body.naturalHeight);
});

// 宽高都写死：只给 height + width:auto 时，元素的**固有尺寸**会漏进窗口，
// 把窗口撑大（实测 img 换姿势、video 加载后都会），窗口一被重建就会丢掉置顶。
function applyMediaSize(el) {
  const vw = el.videoWidth || el.naturalWidth;
  const vh = el.videoHeight || el.naturalHeight;
  if (!vw || !vh) return;
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pet-h')) || 233;
  el.style.height = `${h}px`;
  el.style.width = `${Math.round(h * (vw / vh))}px`;
}

body.addEventListener('load', () => applyMediaSize(body));

// ---------------------------------------------------------------- 气泡

let bubbleTimer = null;

function showBubble(text, face, ms = 10000) {
  // 只有表情、没有台词也要能显示（右键「换个表情」就是这种）
  if (!text && !face) return hideBubble();
  bubbleText.textContent = text || '';
  bubbleText.hidden = !text;
  bubble.classList.toggle('face-only', !text);
  if (face) {
    bubbleFace.src = facePath(face);
    bubbleFace.hidden = false;
  } else {
    bubbleFace.hidden = true;
  }
  bubble.classList.remove('hidden');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble() {
  bubble.classList.add('hidden');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = null;
}

// ---------------------------------------------------------------- 动作片段

// 由 scripts/make-emote-clips.py 生成，主进程读 manifest 后经 readConfig 送过来。
// 播完就退回立绘；working 这种长状态才循环。
let clips = {};
let activeClip = null;

function playClip(name, loop = false) {
  const info = clips && clips[name];
  if (!info) return false;
  if (activeClip === name) {
    if (animEl.paused) animEl.play().catch(() => {});
    return true;
  }
  activeClip = name;
  petEl.classList.add('clip');
  animEl.loop = loop;
  animEl.src = `../../assets/pet/${info.file}`;
  try {
    animEl.currentTime = 0;
  } catch {
    /* 还没加载完时忽略 */
  }
  animEl.play().catch(() => stopClip()); // 片段坏了就退回立绘，别让宠物消失
  kick();
  return true;
}

function stopClip() {
  if (!activeClip) return;
  activeClip = null;
  petEl.classList.remove('clip');
  animEl.pause();
}

animEl.addEventListener('ended', () => {
  if (!animEl.loop) stopClip();
});

// ---------------------------------------------------------------- 形变循环

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 空闲时彻底停掉 JS 侧形变：呼吸由 CSS 动画负责（合成器线程）。
// 之前是每帧无条件写 transform，白烧主线程，是掉帧的来源之一。
let rafActive = false;

function applyTransform() {
  body.style.transform =
    `translate(${view.lagX.toFixed(2)}px, ${view.lagY.toFixed(2)}px) ` +
    `rotate(${view.tilt.toFixed(2)}deg) ` +
    `scale(${(view.sx * view.facing).toFixed(3)}, ${view.sy.toFixed(3)})`;
}

// ---------------------------------------------------------------- 弹簧与逐帧

/** 一步阻尼弹簧：目标值 + 劲度 + 阻尼 → 新的 [值, 速度] */
function springStep(value, vel, target, k, c, h) {
  const acc = (target - value) * k - vel * c;
  const v = vel + acc * h;
  return [value + v * h, v];
}

function frame(now) {
  const dt = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.05) : 0.016;
  lastFrameAt = now;
  // 固定步长积分，帧率波动时手感才一致
  const h = dt / 3;

  const busy =
    view.dragging ||
    Math.abs(view.sy - 1) > 0.003 ||
    Math.abs(view.syV) > 0.02 ||
    Math.abs(view.lagX) > 0.05 ||
    Math.abs(view.lagY) > 0.05 ||
    Math.abs(view.tilt - view.tiltTarget) > 0.05;

  if (!busy) {
    // 空闲时彻底停掉 JS：呼吸交给 CSS 动画（合成器线程），这里一点主线程都不占
    view.sy = 1;
    view.syV = 0;
    view.sx = 1;
    view.lagX = view.lagY = view.lagVX = view.lagVY = 0;
    view.tilt = view.tiltTarget;
    applyTransform();
    rafActive = false;
    lastFrameAt = 0;
    return;
  }

  for (let i = 0; i < 3; i++) {
    [view.sy, view.syV] = springStep(view.sy, view.syV, 1, SQUASH_K, SQUASH_C, h);
    [view.lagX, view.lagVX] = springStep(view.lagX, view.lagVX, 0, LAG_K, LAG_C, h);
    [view.lagY, view.lagVY] = springStep(view.lagY, view.lagVY, 0, LAG_K, LAG_C, h);
  }
  view.sx = Math.pow(Math.max(0.2, view.sy), -VOLUME_EXP);
  view.tilt += (view.tiltTarget - view.tilt) * 0.15;
  applyTransform();
  requestAnimationFrame(frame);
}

function kick() {
  if (rafActive) return;
  rafActive = true;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 帧率探针

// "不丝滑"这种说法没法验证，所以直接量：把一帧的间隔取样后统计 p50/p95/超 32ms 的帧数。
function probeFrames(label, ms = 3000) {
  const deltas = [];
  let last = performance.now();
  const t0 = last;
  const tick = (now) => {
    deltas.push(now - last);
    last = now;
    if (now - t0 < ms) {
      requestAnimationFrame(tick);
      return;
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    window.pet.reportFrames({
      label,
      frames: deltas.length,
      p50: +pick(0.5).toFixed(1),
      p95: +pick(0.95).toFixed(1),
      worst: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
      over32: deltas.filter((d) => d > 32).length,
    });
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- 命中与拖拽

function petRect() {
  const r = body.getBoundingClientRect();
  return { x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 };
}

function insidePet(e) {
  const b = petRect();
  return e.clientX >= b.x0 && e.clientX <= b.x1 && e.clientY >= b.y0 && e.clientY <= b.y1;
}

let interactive = false;
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  window.pet.setInteractive(on);
}

let hist = [];
let dragMoved = false;

function velocityFromHist() {
  if (hist.length < 2) return { vx: 0, vy: 0 };
  const last = hist[hist.length - 1];
  let ref = hist[0];
  for (let i = hist.length - 2; i >= 0; i--) {
    if (last.t - hist[i].t >= 30) {
      ref = hist[i];
      break;
    }
  }
  const dt = Math.max((last.t - ref.t) / 1000, 0.001);
  return { vx: (last.x - ref.x) / dt, vy: (last.y - ref.y) / dt };
}

function onPetClick() {
  // 压扁到 60%，然后交给弹簧带回弹过冲——比指数衰减"活"得多
  view.sy = 0.6;
  view.syV = 0;
  kick();
  playClip('wave'); // 点一下先招手；片段不存在时静默跳过
  const faces = [1, 2, 3];
  const face = faces[Math.floor(Math.random() * faces.length)];
  const line = CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)];
  showBubble(line, face, 4000);
}

window.addEventListener('mousemove', (e) => {
  if (view.dragging) {
    hist.push({ t: performance.now(), x: e.screenX, y: e.screenY });
    if (hist.length > 6) hist.shift();
    if (hist.length > 1) dragMoved = true;
    window.pet.dragMove({ screenX: e.screenX, screenY: e.screenY });
    view.tiltTarget = clamp(-(e.movementX || 0) * 0.8, -10, 10);
    // 弹性跟手：窗口是刚性追随指针的（位置归主进程），所以把弹性做成**立绘相对窗口的滞后**。
    // 快速拖动时身体往后坠一点，弹簧再把它拉回 0，读起来就是"被拎着晃"。
    view.lagX = clamp(view.lagX - (e.movementX || 0) * 0.45, -22, 22);
    view.lagY = clamp(view.lagY - (e.movementY || 0) * 0.45, -22, 22);
    kick();
    return;
  }
  const inside = insidePet(e);
  setInteractive(inside);
  const b = petRect();
  view.tiltTarget = inside ? clamp((e.clientX - (b.x0 + b.x1) / 2) * 0.04, -3.5, 3.5) : 0;
  kick();
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !insidePet(e)) return;
  // 套 try/catch：之前这里抛过异常，导致 dragStart 永远发不出去、拖动整个失效，
  // 而异常原文只出现在 devtools 里看不到。写进日志，根因就自己浮现了。
  try {
    view.dragging = true;
    dragMoved = false;
    hist = [{ t: performance.now(), x: e.screenX, y: e.screenY }];
    stage.classList.add('dragging');
    setInteractive(true);
    // 先发 drag-start 再做任何可选动画：动画再出异常也不能把拖动拖下水
    window.pet.dragStart({ screenX: e.screenX, screenY: e.screenY });
    kick();
  } catch (err) {
    window.pet.reportFrames({
      label: `mousedown ERROR: ${err && err.message}`,
      frames: 0, p50: 0, p95: 0, worst: 0, over32: 0,
    });
  }
  e.preventDefault();
});

window.addEventListener('mouseup', (e) => {
  if (!view.dragging) return;
  view.dragging = false;
  stage.classList.remove('dragging');
  const { vx, vy } = velocityFromHist();
  window.pet.dragEnd({ vx, vy });
  if (!dragMoved) onPetClick();
  hist = [];
  kick();
  probeFrames('after-drag');
});

window.addEventListener('mouseleave', () => {
  if (!view.dragging) setInteractive(false);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (insidePet(e)) window.pet.menu();
});

// ---------------------------------------------------------------- 会话状态

window.pet.onState(({ state, pose, face, text }) => {
  if (pose && SPRITES[pose]) body.src = SPRITES[pose];
  if (state === 'working') playClip('read', true);
  else if (state === 'success') playClip('love');
  else if (state === 'idle') {
    if (activeClip === 'read' || activeClip === 'love') stopClip();
  } else stopClip();
  if (state === 'working') view.facing = 1;
  if (state === 'success') {
    view.sy = 1.14; // 拉伸一下（往上蹦），弹簧带回落
    view.syV = 0;
    kick();
  }
  if (state === 'error') {
    view.sy = 0.86;
    view.syV = 0;
    kick();
  }
  if (text || face) {
    // 无台词的纯表情：只停 4 秒，别一直挡着桌面
    const ms = text ? (state === 'whisper' ? 8000 : 10000) : 4000;
    showBubble(text, face, ms);
  }
  else hideBubble();
});

window.pet.onMotion(({ vx, vy, mode, facing }) => {
  view.facing = facing === -1 ? -1 : 1;
  if (mode === 'throw') {
    view.tiltTarget = clamp(-vx * 0.012, -12, 12);
    view.lastThrowVy = vy; // 记着下落速度，落地时按冲击深浅压扁
  } else if (mode === 'walk') {
    view.tiltTarget = 0;
  } else if (view.lastThrowVy !== 0) {
    // 落地：轻落压得浅、重砸压得深，这才是"摔下去有回弹"而不是停止
    const impact = Math.min(1, Math.abs(view.lastThrowVy) / 2200);
    if (impact > 0.06) {
      view.sy = 1 - 0.4 * impact;
      view.syV = 0;
    }
    view.lastThrowVy = 0;
  }
  kick();
});

window.pet.readConfig().then((cfg) => {
  if (cfg && cfg.petHeight) {
    document.documentElement.style.setProperty('--pet-h', `${cfg.petHeight}px`);
  }
  clips = (cfg && cfg.clips) || {};
  probeFrames('idle');
});
