// preload：只暴露桌宠真正需要的那几个通道。
// 用 .cjs 是为了在 "type": "module" 的包里保持 CommonJS preload（Electron 官方推荐写法）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // 命中区控制：透明像素要点击穿透到下层应用
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),
  setSpriteSize: (w, h) => ipcRenderer.send('pet:sprite-size', { w, h }),
  dragStart: (payload) => ipcRenderer.send('pet:drag-start', payload),
  dragMove: (payload) => ipcRenderer.send('pet:drag-move', payload),
  dragEnd: (payload) => ipcRenderer.send('pet:drag-end', payload),
  menu: () => ipcRenderer.send('pet:menu'),
  whisper: () => ipcRenderer.invoke('pet:whisper'),
  readConfig: () => ipcRenderer.invoke('pet:config'),
  // 帧率探针：把测量结果送回主进程写日志，让"丝不丝滑"有数字可查
  reportFrames: (stats) => ipcRenderer.send('pet:frames', stats),
  onState: (fn) => ipcRenderer.on('pet:state', (_e, payload) => fn(payload)),
  onMotion: (fn) => ipcRenderer.on('pet:motion', (_e, payload) => fn(payload)),
  onPlayClip: (fn) => ipcRenderer.on('pet:play-clip', (_e, name) => fn(name)),
});
