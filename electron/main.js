const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
app.setName('DevDock'); // menu bar reads this, not the bundle name
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4003;
let mainWindow = null;
let tray = null;
let serverProcess = null;

// Single instance lock — kill the duplicate immediately
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

function getResourcePath(file) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', file);
  }
  return path.join(__dirname, '..', file);
}

function startServer() {
  serverProcess = spawn(process.execPath, ['--no-warnings', getResourcePath('server.js')], {
    env: { ...process.env, ELECTRON: '1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serverProcess.stdout?.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d));
  serverProcess.on('error', (err) => console.error('Server error:', err));
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#0b0e13',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      app.dock?.hide(); // Remove from Cmd+Tab and dock
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  if (tray) return;

  const iconPath = getResourcePath('assets/trayTemplate.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);

  updateTrayMenu(0);
  tray.setToolTip('DevDock');

  // Right-click or left-click both show the context menu
  tray.on('click', () => {
    tray.popUpContextMenu();
  });

  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ports`);
      const data = await res.json();
      updateTrayMenu(data.count || 0);
    } catch {}
  }, 5000);
}

function updateTrayMenu(count) {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: `DevDock — ${count} listener${count !== 1 ? 's' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Dashboard', click: () => { app.dock?.show(); if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
    { label: 'Open History', click: () => { app.dock?.show(); if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.loadURL(`http://localhost:${PORT}/history`); } } },
    { type: 'separator' },
    { label: 'Launch at Startup', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit DevDock', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`DevDock — ${count} listener${count !== 1 ? 's' : ''}`);
}

// ── Menu bar (standard macOS layout and shortcuts) ──────────────────
function command(cmd) {
  if (!mainWindow) return createWindow();
  app.dock?.show(); mainWindow.show(); mainWindow.focus();
  mainWindow.webContents.executeJavaScript(`window.devdockCommand?.(${JSON.stringify(cmd)})`).catch(() => {});
}

function buildAppMenu() {
  const item = (label, accelerator, cmd) => ({ label, accelerator, click: () => command(cmd) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      item('Settings…', 'Cmd+,', 'settings'),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { label: 'Quit DevDock', accelerator: 'Cmd+Q', click: () => { app.isQuitting = true; app.quit(); } },
    ] },
    { label: 'File', submenu: [
      item('Export…', 'Shift+Cmd+E', 'export'),
      { type: 'separator' },
      { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      item('Find', 'Cmd+F', 'find'),
      { type: 'separator' },
      item('Servers', 'Cmd+1', 'tab-servers'),
      item('Sessions', 'Cmd+2', 'tab-sessions'),
      item('Containers', 'Cmd+3', 'tab-containers'),
      item('Apps', 'Cmd+4', 'tab-apps'),
      item('Agents', 'Cmd+5', 'tab-coding'),
      item('Home', 'Cmd+6', 'tab-home'),
      item('Machines', 'Cmd+7', 'tab-machines'),
      { type: 'separator' },
      item('Next Grouping', 'Shift+Cmd+G', 'group-menu'),
      { type: 'separator' },
      item('Toggle Appearance', 'Shift+Cmd+L', 'theme'),
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: 'Go', submenu: [
      item('Dashboard', 'Cmd+[', 'back'),
      item('History', 'Cmd+Y', 'history'),
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [item('Keyboard Shortcuts   ?', undefined, 'help')] },
  ]));
}

// ── App lifecycle ────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  startServer();
  buildAppMenu();

  let started = false;
  const check = setInterval(async () => {
    if (started) return;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`);
      if (res.ok) {
        started = true;
        clearInterval(check);
        createWindow(); createTray();
      }
    } catch {}
  }, 100);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.isQuitting = true; app.quit(); }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});
