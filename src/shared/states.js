/**
 * 会话状态表：每个状态对应的立绘姿势、表情格和气泡文案。
 * 文案结构照抄 dsh-pet 的 workStatusTexts：每档多个备选，播放时随机抽一句。
 * 表情格编号是设计稿「表情参考」那一排从左到右的顺序（我读图得到的标签，可能有个别偏差）。
 */

export const FACE_LABELS = [
  '开心',
  '害羞',
  '生气',
  '惊讶',
  '委屈',
  '难过',
  '疑惑',
  '害羞·笑',
  '睡觉',
  '小Claude',
];

export const STATES = {
  idle: { pose: 'front', texts: [] },
  thinking: {
    pose: 'front',
    texts: ['正在认真想下一步呢', '让我整理一下思路~', '正在梳理接下来要做什么'],
  },
  working: {
    pose: 'side',
    texts: ['正在处理任务呢', '这一步正在进行中哦', '正在继续干活呢，别打扰我~'],
  },
  result: {
    pose: 'front',
    texts: ['这一步处理好啦，接着看下一步', '搞定一步，继续看看哦~'],
  },
  waiting: {
    pose: 'front',
    texts: ['需要你确认一下呢', '这里要等你看一下哦', '轮到你来决定啦，等你~'],
  },
  success: {
    pose: 'front',
    texts: ['这一轮搞定啦，真棒！', '任务完成咯，可以摸鱼啦~'],
  },
  error: {
    pose: 'front',
    texts: ['这一步好像没跑通呢', '刚才的操作遇到点问题哦', '这里卡了一下，再等等你呢'],
  },
  sleep: { pose: 'front', texts: ['……Zzz'] },
};

export function pickText(state, rng = Math.random) {
  const texts = STATES[state]?.texts ?? [];
  if (!texts.length) return null;
  return texts[Math.floor(rng() * texts.length)];
}