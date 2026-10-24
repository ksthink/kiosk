const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.off('state:changed', h);
  },
  saveBanner: (b) => ipcRenderer.invoke('banner:save', b),
  removeBanner: (id) => ipcRenderer.invoke('banner:remove', id),
  reorderBanners: (ids) => ipcRenderer.invoke('banner:reorder', ids),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  crawlNow: (id) => ipcRenderer.invoke('crawl:now', id),
  testCrawl: (input) => ipcRenderer.invoke('crawl:test', input),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file), // 끌어다 놓은 파일의 실제 경로
  openLink: (url) => ipcRenderer.send('link:open', url),
  openAdmin: () => ipcRenderer.send('admin:open'),
  setFullscreen: (v) => ipcRenderer.send('gallery:fullscreen', v),
});
