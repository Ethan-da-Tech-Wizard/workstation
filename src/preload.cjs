'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('workstation', {
  mode: process.argv.includes('--workstation-guest') ? 'guest' : 'host',
  request: (action, input) => ipcRenderer.invoke('workstation:action', action, input),
  droppedFiles: files => ipcRenderer.invoke('workstation:action', 'importDropped', files.map(file => webUtils.getPathForFile(file))),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on('workstation:changed', listener);
    return () => ipcRenderer.removeListener('workstation:changed', listener);
  },
  onProgress: callback => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on('workstation:progress', listener);
    return () => ipcRenderer.removeListener('workstation:progress', listener);
  }
});
