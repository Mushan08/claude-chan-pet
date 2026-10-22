# HANDOFF · claude-chan-pet

> 写于 2026-10-22 20:40。上一会话的 transcript 已到 44.5 MB（79 张截图，base64 共 32.3 MB），
> 超过网关 16 MB 的 request body 上限，任何新消息都会被 400 拒掉。这份文件用来接续。

## 新会话开场（直接粘贴）

```
接着做 claude-chan-pet，workspace 是 E:\cc_workplace。
先读 E:\cc_workplace\claude-chan-pet\HANDOFF.md、README.md、docs/design.md，再看 src/main.js。
不要重新读设计稿大图，需要视觉确认就自己跑 --selftest 出图后报路径。
```

## 项目是什么

Claude 娘 Electron 透明桌宠，接 Claude Code hooks（事件 -> 表情/气泡）。
素材来自用户给的三视图设计稿，已用 `scripts/make-sprites.py` 裁切+边缘洪水填充去底，产物在 `assets/pet/`。

## 现状（已落盘、已验证）

| 项 | 状态 |
| --- | --- |
| `src/main.js`（673 行，约 22 KB） | 最后改动 20:37 |
| 帧率 | p50 5.6 ms / p95 5.6 ms，>32 ms 0 帧（启动首帧 85 ms 属加载） |
| 窗口 | 280×344，贴任务栏上沿；`will-resize` 直接拒绝；`setMaximumSize` 先放开再 `setBounds` |
| 自检 | `out/selftest-idle.png`、`out/selftest-state.png` 已生成 |
| Hooks | 已写入 `E:\cc_workplace\.claude\settings.json`，覆盖 9 个事件 |
| 运行 | `pwsh -NoProfile -File scripts/run.ps1`；自检加 `--selftest` |

## 未完成 / 待确认

1. **窗口仍会被放大**：`will-resize` 不触发、日志里也没拦住，判断是更底层在改尺寸；已做的纠正让位移不可见，但根因没钉死。
2. 用户新发的设计稿设定图没进会话（发送时就被 400 挡了），需要重发——**缩到 1280 宽再发**。
3. 视觉验收：纠正后「宠物站位不动、放大只多一圈透明像素」是否符合预期，还没看过。

## 这个会话踩的坑（避免复发）

- 每轮贴 2560×1600 全屏截图 ≈ 0.6 MB base64，79 张就 32 MB。**先缩图或只给文件路径**。
- 长会话每 30~50 轮换新会话，换之前写一份 HANDOFF。
- 400 `Exceeded limit on max bytes to request body: 16777216` 是**字节数**超限，不是 token 超限（当时上下文才 36%）。

## 2026-10-22 22:55 接管记录（Codex）

- **拖不动的根因**：21:5x 的重构把 `pet.js` 里的 `kick()` / `frame()` / `probeFrames()` 整段删掉，
  但所有调用点都留着。`mousedown` 里 `kick()` 先抛 `kick is not defined`，
  后面的 `window.pet.dragStart()` 永远执行不到 → 主进程只能从 `drag-move` 反推，手感全毁。
- **修复**：补回弹簧积分 + 逐帧循环 + 帧率探针（没有恢复已删除的 `<video>` 片段层），
  并把 `dragStart()` 挪到 `kick()` 之前——以后动画再炸也不影响拖动。
- **验证**：`pet.log` 中 `drag-start` 不再带 `(inferred)`，拖拽 / 甩抛 / 落地回弹正常；
  `--selftest` 正常出图；`mousedown ERROR` 归零。
- **仍未解决**：窗口会被外部放大（日志里 412x454、429x474 等），`ensureWindowSize` 每 8 秒拉回一次；
  Electron 的 `resized` 事件不触发，根因未钉死。
- **新素材**：5 段 960x720 / 4s 的动作参考（抱玩偶、招手、喝茶、比心、读书），
  背景是近白 `#F4F6F6`，和裙子奶白撞色，不适合直接 colorkey 抠成透明本体。

## 2026-10-22 23:10 第二轮（Codex）

- **「换个表情」没反应**：菜单 `click: () => setState(currentState, { face: n, text: null })`，
  而 `STATES.idle.texts` 是空数组 → `pickText('idle')` 返回 null → 渲染层 `if (text) showBubble() else hideBubble()`
  直接把脸丢了。修复：渲染层改成 `if (text || face)`，无台词时显示 64px 的表情小卡（`#bubble.face-only`），停 4 秒。
  自检新增 `out/selftest-face.png` 做回归。
- **情绪动作片段**：`scripts/make-emote-clips.py` 把 4 段参考视频逐帧抠像（边缘洪水填充 + 最大连通域 + 1px 腐蚀 + 羽化），
  编码成 VP9/yuva420p 的透明 WebM，产物在 `assets/pet/anims/`。映射：`working`→read（循环）、
  `success`→love（一次）、点击→wave（一次），播完 `stopClip()` 退回立绘。
- **喝茶那段没做**：桌布是白色，和裙子同色，最大连通域会把桌子和人连在一起；硬裁会切到头发。
  要做只能手绘 mask，暂缓。
- **注意**：`#anim` 是绝对定位、底边对齐 `#pet`；`#pet.clip #body` 必须用 `visibility:hidden` 而不是 `display:none`，
  否则 `#pet` 塌成 0 高，气泡会掉到底部压住片段。

## 2026-10-22 23:20 第三段素材

- 新增 `think`（书桌 + 举手灵光一闪），绑定 `thinking` 状态，右键「动作 → 想到办法」也可点播。
- 这段的书桌和手臂连在一起，最大连通域拆不开；按「书桌场景」整体保留，没有硬裁。

## 2026-10-22 23:25 第四轮（画质）

- **太小 / 看不清**：窗口宽度改成 `max(立绘宽, 最宽片段按 petHeight 缩放后的宽)`。
  现在 353x346，`read` 片段能按 233px 高满幅显示，不再被压到 185px。
- **清晰度**：编码从 320p/CRF32 → **560p/CRF20**，单段约 1.5 MB（5 段共 7.5 MB）。
- **白边**：抠图从「按颜色取前景 + 最大连通域」改成 **从边框洪水填充纸色（TOL 60）**，
  和头发丝之间的纸色缝隙连通的那部分会跟着背景一起走；再加上边缘 despill
  （`F=(C-(1-a)B)/a`）。裙子/玩偶是被描边包住的封闭区域，仍然不透明。
- 仍然做不到的：完全被头发围死的纸色小口袋，和奶白裙子颜色一样，没有分割模型分不开。
  `rembg`/`onnxruntime` 在 Anaconda 里 import 直接 0xC0000005 段错误，放弃。

## 2026-10-22 23:30 自动动作

- 空闲时每 **25~70 秒**自己随机播一段动作（不连续重复同一段），播完回立绘。
  入口是 `pet.js` 里的 `scheduleIdleAction()`。
- 点击宠物 = 捏一下：`mousedown` 先 `stopClip()` 退出当前动作，再走原来的 Q 弹 + 气泡。
- 立绘和片段之间加了 120ms 交叉淡入，避免硬切。
- 已知：窗口会被别的前台窗口压住（置顶偶尔失效），`WindowFromPoint` 也点不到；
  这是 Electron 置顶 + 点击穿透的老问题，和动作无关。
