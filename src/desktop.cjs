const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme, screen } = require('electron');
const path = require('node:path');
const { createServer } = require('./server.cjs');
app.setName('Blots');
app.commandLine.appendSwitch('disk-cache-size', '33554432');
let backend, window, cursorWindow, quitting = false, cleanedUp = false;
// A transparent, click-through window over the display draws the bot's cursor on the user's Mac.
function macPointer(frame, bot) {
  const point = { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) }, display = screen.getDisplayNearestPoint(point);
  if (!cursorWindow || cursorWindow.isDestroyed()) {
    cursorWindow = new BrowserWindow({ frame: false, transparent: true, hasShadow: false, focusable: false, skipTaskbar: true, resizable: false, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    cursorWindow.setIgnoreMouseEvents(true); cursorWindow.setAlwaysOnTop(true, 'screen-saver'); cursorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    cursorWindow.loadFile(path.join(__dirname, '..', 'public', 'mac-cursor.html'));
  }
  cursorWindow.setBounds(display.bounds); cursorWindow.showInactive();
  const draw = () => cursorWindow.webContents.executeJavaScript(`point(${point.x - display.bounds.x}, ${point.y - display.bounds.y}, ${JSON.stringify(bot?.color || '#4d7edb')}, ${JSON.stringify(bot?.name || '')})`).catch(() => {});
  if (cursorWindow.webContents.isLoading()) cursorWindow.webContents.once('did-finish-load', draw); else draw();
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    backend = await createServer({ port: 0, dataDir: app.getPath('userData'), macPointer });
    backend.computers.sweep();
    const makeWindow = () => {
      window = new BrowserWindow({ width: 1480, height: 940, minWidth: 950, minHeight: 650, title: 'Blots', backgroundColor: '#111112', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(backend.origin + '/')) event.preventDefault(); });
      window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      window.loadURL(backend.origin); window.on('closed', () => { window = null; cursorWindow?.destroy(); });
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
