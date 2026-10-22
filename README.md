# claude-chan-pet

一只用**你自己的设计稿**做的 Claude 娘桌宠，接到 **Claude Code** 上：你在会话里干活，它就在桌面上跟着你的状态换表情、冒气泡、偶尔碎碎念。

模仿 **dsh-pet**（DeepSeek Harness 的那只蓝色大肥鱼桌宠，本机在 `~/.dsh/profiles/desktop/node_modules/dsh-pet`）的思路做的，逐项对照见 `docs/design.md`。

![待机与状态](out/selftest-state.png)

## 效果

- **待机呼吸 / 轻微摇摆**：立绘是 Q 版全身，站在任务栏上沿。
- **跟着会话做表情**：你提问 → 看书；工具调用 → 伏案；工具完成 → 端杯；等你确认 → 说话；回合结束 → 比心；出错 → 蹲下；会话开始 → 挥手。
- **十二个动作姿势**，从设定稿「动态动作」块切出来的：站立 / 坐下 / 蹲下 / 躺下 / 抱小Claude ×2 / 比心 / 挥手 / 说话 / 思考 / 喝茶 / 看书。右键「动作」可以随手点播，每个动作都有对应台词。
- **气泡**：工作状态文案 + 表情缩略图，10 秒后自己收起来。文案每档三句备选，随机抽。
- **情绪动作片段**：5 段逐帧抠像的透明 WebM（抱玩偶 / 招手 / 比心 / 看书 / 想到办法）。`thinking` → 想到办法、`working` → 看书、`success` → 比心；**空闲时每 12~15 秒自己随机来一段**，播完自动退回立绘。右键「动作」可手动点播。生成脚本 `scripts/make-emote-clips.py`，产物在 `assets/pet/anims/`。
- **碎碎念**：默认 20~30 秒一句，表情随机，本地台词池，**不花模型钱**。
- **交互**：点击 = 捏一下（Q 弹 + 一句短回应），并**立即退出正在播的动作**；拖拽跟手；松手按轨迹甩出去，抛物线 + 碰壁反弹 + 落地摩擦；右键菜单（碎碎念 / 换表情 / 动作 / 回到初始位置 / 重载配置 / 退出）。
- **自己会溜达**：闲着的时候随机走到别处，20~60 秒一次。

## 运行方式

```powershell
pwsh -NoProfile -File scripts/run.ps1
```

会自动找 Electron（优先 `~/.dsh/electron/electron.exe`，也可用环境变量 `CLAUDE_CHAN_PET_ELECTRON` 指定），**不需要 npm install**。

自检模式（不碰桌面，让窗口自己截图自己，用来验证渲染）：

```powershell
pwsh -NoProfile -File scripts/run.ps1 --selftest
```

产物落在 `out/selftest-idle.png` 和 `out/selftest-state.png`。

## 接到 Claude Code 上（hooks）

桌宠靠一个 hook 脚本接收会话事件：Claude Code 把事件 JSON 从 stdin 喂给 `hooks/claude-chan-pet-hook.mjs`，它追加一行到 `~/.claude-chan-pet/events.jsonl`，桌宠进程 tail 这个文件（`fs.watch` + 2 秒轮询兜底）。

把 `hooks/settings-snippet.json` 里的内容合并进 `.claude/settings.json` 即可（路径按需改）。hook 只写文件、永远 `exit 0`、不往 stdout 写东西，**不会影响会话本身**。

**当前已经装好**：写在 `E:\cc_workplace\.claude\settings.json`，覆盖 9 个事件（下面 8 个 + `PostToolUseFailure` → error）。`hooks/settings-snippet.json` 保留为可移植模板。

⚠️ 两点要知道：

- **它只对"项目根目录是 `E:\cc_workplace`"的会话生效**。直接在子目录（如 `E:\cc_workplace\claude-chan-pet`）里新开会话时，那份 settings 不会被加载。想全局生效就把它挪到 `C:\Users\MushanLuo\.claude\settings.json`（代价是所有项目的每次工具调用都会多起一个 node 进程，约 60ms）。
- **每次工具调用会起两次 node 进程**（PreToolUse + PostToolUse）。嫌卡就把 `PostToolUse` 那段删掉，只留 PreToolUse。
- 改完 settings 后**要新开会话**才会加载（本会话内新建的文件能不能被热加载，取决于 settings 监视器覆盖的目录）。

事件 → 状态 的映射写在配置里（`eventStates`），改配置就能改行为，不用动代码：

| 事件 | 状态 |
| --- | --- |
| `UserPromptSubmit` | thinking（疑惑） |
| `PreToolUse` | working（侧身干活） |
| `PostToolUse` | result（害羞） |
| `Notification` | waiting（惊讶，等你确认） |
| `Stop` | success（开心，跳一下） |
| `SubagentStop` | result |
| `SessionStart` / `SessionEnd` | idle |

## 配置

用户配置放 `~/.claude-chan-pet/config.json`，只写要覆盖的字段（顶层字段整段替换，缺的子键不回补）。可调：

- `pet.height` — 立绘显示高度（默认 233）。**基准取高度不取宽度**：正面/侧面/背面三张素材等高但宽窄不同，按宽度对齐会让宠物换姿势时忽胖忽瘦、窗口跟着改尺寸。
- `physics` — `gravity` / `restitution` / `groundFriction` / `ceilingBounce` / `throwPower`
- `wander` — `enabled` / 间隔秒数 / 走动距离 / 速度
- `work.settleSec` — 工作状态多少秒后回 idle
- `whisper` — `enabled` / `intervalSec`
- `eventStates` — 事件名到状态的映射
- `stateFaces` — 状态到表情格编号的映射
- `lines` — 自定义碎碎念台词池（`null` = 用内置）
- `window.topmostWatchdog` — 是否定期重申窗口置顶
- `window.groundOffsetPx` — 站立基准线相对工作区底边的偏移（px，正数 = 抬高）。默认 0，也就是脚站在任务栏上沿；嫌她太贴边就调这个。
- `physics.dropThresholdPx` — 松手速度低于此值算"温柔放下"：**原地停住**，不启动重力（默认 140）。这是把宠物放到桌面任意位置的前提。

## 结构

```
src/main.js            主进程：透明窗 + 运动引擎（漫游/拖拽/抛掷）+ 事件桥
src/preload.cjs        只暴露桌宠需要的通道
src/renderer/          立绘、气泡、Q 弹与倾斜的视觉表现
src/shared/            两端共用：配置、状态表与文案、台词池
hooks/                 事件桥脚本 + settings 片段
scripts/               run.ps1 启动、make-sprites.py 切图、analyze-sheet.py 量版面
assets/source/         原始设计稿（两张）
assets/pet/            切好的透明立绘与表情（含 manifest.json）
out/                   自检截图
```

## 逐帧动画（管线已打通，暂未接在桌宠上）

桌宠现在用的是**清晰的三视图立绘 + 程序化动作**（呼吸 / 挤压 / 拖拽 / 甩抛）。

逐帧视频那条管线已经跑通并逐项验证过（见 `.claude/skills/pet-animation`），但**没有接在桌宠上**——
实测接上去反而更差：片段画布比立绘大一圈（人物只占其中约 85%），加上视频压缩，放出来比原生 PNG
更小、更肉。所以撤了。

要接回来就按 skill 走两步：①出真片（**画面填满人物**、纯绿幕、首尾同姿势）→ 一条命令
`add-clip.py` 转成透明 WebM；②按 skill 把 `<video>` 那层接回渲染层（约 30 行，先前实现已在该 skill 里记录）。

生成流程（工具链在 `.claude/skills/pet-animation`）：

```bash
# 1) AI 视频工具出一段「纯绿背景 + 全身入画 + 首尾同姿势」的短片
# 2) 绿幕 -> 透明 WebM（chromakey + despill -> VP9 alpha）
python -I .claude/skills/pet-animation/greenscreen2webm.py in.mp4 assets/pet/anims/idle.webm
# 没有真片时，可以用样片生成器验证管线：
python -I .claude/skills/pet-animation/make-demo-clip.py assets/pet/front.png out/green.mp4 --height 420
```

渲染层不探测文件：有 `anims/<动作或 idle>.webm` 就播 `<video>`，加载失败就自动退回静态立绘
（靠 `canplay`/`error` 事件切换）。加新动作片段只要丢文件进 `assets/pet/anims/`。

四个必须记住的坑（详见 skill）：`-auto-alt-ref 0` 不关会丢 alpha；alpha 的凭据是流上的
**`alpha_mode 1`**（ffprobe 的 pix_fmt 会显示 yuv420p，别被骗）；**验证必须用 `libvpx-vp9` 解码器**
（原生 vp9 解码器不支持 alpha，会得到假阴性）；**绿边要用 `despill`**——那是 4:2:0 色度下采样
把绿抹进边缘造成的，光调 chromakey 参数治不好（实测加了 despill 后绿色残留从肉眼可见变成 0 像素）。

## 素材怎么来的

原始设计稿是**平底图，没有 alpha 通道**，直接放透明窗会露出奶白方块。所以切图分三步：

1. `scripts/analyze-sheet.py` 用行列投影量出每块内容的真实坐标（不靠肉眼猜）；相邻块贴太近时可以给一个子区域只量那一块；
2. `scripts/make-sprites.py` / `make-action-sprites.py` 按量出来的框裁切，再**从裁切边缘洪水填充**抹掉奶白纸底——只吃掉与纸底连通且颜色接近的区域，所以白裙子内部不会被误伤；抠完还会**腐蚀 1px + 高斯羽化**，否则 0/255 硬边在屏幕上就是阶梯毛刺，深色背景上还会有一圈奶油色白晕；
3. **`.claude/skills/image-upscale`** 给太小的素材超采样：动作小格只有 106×154，放到 233px 高要放大 1.5 倍会发虚，先 2× 超采样让渲染端改成**缩小**。锐度实测 +28%~+54%（Laplacian 方差，透明通道保留）。

重新生成：

```powershell
python -I scripts/make-sprites.py assets/source/sheet-threeview.png assets/pet
python -I scripts/make-action-sprites.py assets/source/sheet-closet-b.webp assets/pet
python -I .claude/skills/image-upscale/upscale.py "assets/pet/act-*.png" --scale 2
```

> ⚠️ **动作素材只有约 106×154 px**，是这套素材的清晰度上限。想要更锐，需要一版高分辨率的动作立绘（像三视图那样 ~390×460），或者装上 waifu2x-ncnn-vulkan 走 AI 超分（本机暂时下不动 GitHub 的二进制，见 skill 里的说明）。

> ⚠️ 动作素材**按格子序号命名**（`act-01..12`），不按姿势名——设定稿的标题行和图上画的姿势并不总是一致（实测第二行第 2 格画的是抱着小玩偶，标题却不是「抱抱」）。我看图得到的描述记在 `assets/pet/actions-manifest.json` 的 `pose_notes` 里，读错某一格只影响配置里一个映射值。

## 已知边界

- **动画是程序化的，不是逐帧素材**。dsh-pet 的 97 段透明 webm 是它花钱用 AI 生成的护城河，这里没有——所以动作是呼吸/Q弹/行走/抛掷这些形变，不是"玩魔方""吃火锅"。要真动作得走同一条管线：三视图 → 动作设计 → 绿幕视频 → VP9-alpha。
- **表情是胸像**，不是全身换脸。当前做法：立绘不变，表情缩略图进气泡。
- **窗口尺寸是锁死的**（`setResizable(false)` + min=max），因为窗口一被撑大，宠物就不再贴窗口底部，可放置范围会被压缩、站立线也会算错。有 2 秒一次的自愈看门狗兜底，每次纠正都写进 `~/.claude-chan-pet/pet.log`。
- **单实例**：第二次启动会直接退出（`requestSingleInstanceLock`）。
- **出问题先看 `~/.claude-chan-pet/pet.log`**：窗口尺寸、素材尺寸、放下/抛掷、异常堆栈都记在里面。主进程还有 `uncaughtException` 兜底——桌宠崩了会写日志而不是弹崩溃框然后消失。
- 碎碎念默认**本地台词池**，不调 API；要接模型得自己加（配置里留了位置）。
- 我是按设计稿读图得到 10 个表情的标签，个别可能有偏差；`stateFaces` 可随时改。



