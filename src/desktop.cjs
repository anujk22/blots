const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const { createServer } = require('./server.cjs');
app.setName('Blots');
app.commandLine.appendSwitch('disk-cache-size', '33554432');
let backend, window, quitting = false, cleanedUp = false;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    backend = await createServer({ port: 0, dataDir: app.getPath('userData') });
    backend.computers.sweep();
    const makeWindow = () => {
      window = new BrowserWindow({ width: 1480, height: 940, minWidth: 950, minHeight: 650, title: 'Blots', backgroundColor: '#111112', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.origin + '/')) event.preventDefault(); });
      window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      window.loadURL(backend.origin); window.on('closed', () => { window = null; });
    };
    ipcMain.handle('blots:workspace', event => { if (event.senderFrame.url.startsWith(backend.origin + '/')) return shell.openPath(backend.store.workspace); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Blots', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'File', submenu: [{ label: 'New conversation', accelerator: 'CmdOrCtrl+N', click: () => window?.webContents.send('blots:new-chat') }, { label: 'Open workspace', click: () => shell.openPath(backend.store.workspace) }, { type: 'separator' }, { role: 'close' }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    makeWindow(); app.on('activate', () => { if (!window) makeWindow(); });
  }).catch(error => { dialog.showErrorBox('Blots couldn’t start', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  // Terminal Ctrl-C, logout and kill run the same cleanup as Quit.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
  app.on('before-quit', event => {
    if (!backend || cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    backend.close({ releaseResources: true }).then(() => { cleanedUp = true; app.quit(); }).catch(error => {
      quitting = false;
      // Never trap the user: a failed cleanup can be retried or skipped. Leftover desktops are stopped on next launch.
      const choice = dialog.showMessageBoxSync({ type: 'warning', message: 'Blots couldn’t finish cleanup', detail: error.message, buttons: ['Try Again', 'Quit Anyway', 'Cancel'], defaultId: 0, cancelId: 2 });
      if (choice === 1) cleanedUp = true;
      if (choice !== 2) app.quit();
    });
  });
}
