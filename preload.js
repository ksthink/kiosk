const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.off('state:changed', h);
  },
  saveBanner: (b) => ipcRenderer.invoke('banner:save', b),
  removeBanner: (id) => ipcRenderer.invoke('banner:remove', id),
  moveBanner: (id, delta) => ipcRenderer.invoke('banner:move', id, delta),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  crawlNow: (id) => ipcRenderer.invoke('crawl:now', id),
  testCrawl: (input) => ipcRenderer.invoke('crawl:test', input),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  openLink: (url) => ipcRenderer.send('link:open', url),
  openAdmin: () => ipcRenderer.send('admin:open'),
  setFullscreen: (v) => ipcRenderer.send('gallery:fullscreen', v),
});
