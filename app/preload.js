'use strict';
// IPC bridge — the renderer panel talks to the engine only through this.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('council', {
  sites: () => ipcRenderer.invoke('council:sites'),
  setRoles: (roster) => ipcRenderer.invoke('council:setRoles', roster),
  run: (cfg) => ipcRenderer.invoke('council:run', cfg),
  mcpToggle: (enabled) => ipcRenderer.invoke('council:mcpToggle', enabled),
  state: () => ipcRenderer.invoke('council:state'),
  saveProject: (p) => ipcRenderer.invoke('council:saveProject', p),
  feedback: (f) => ipcRenderer.invoke('council:feedback', f),
  onProgress: (cb) => ipcRenderer.on('council:progress', (_e, line) => cb(line))
});
