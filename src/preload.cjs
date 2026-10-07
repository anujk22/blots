const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('blotsDesktop', { openWorkspace: () => ipcRenderer.invoke('blots:workspace'), onNewChat: callback => ipcRenderer.on('blots:new-chat', () => callback()) });
