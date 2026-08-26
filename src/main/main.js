'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./db');
const ipc = require('./ipc');
const auth = require('./auth');
const license = require('./license');

app.setName('QAVENO');

let cashierWindow = null;
let adminWindow = null;
let ownerWindow = null;
let loginWindow = null;

function logoPath() {
  const p = path.join(app.getAppPath(), 'assets', 'logo.png');
  return require('node:fs').existsSync(p) ? p : undefined;
}

function trackBinding(win) {
  win.webContents.once('destroyed', () => auth.unbindWindow(win.webContents.id));
}

function createCashierWindow() {
  cashierWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'نقطة البيع — الكاشير',
    autoHideMenuBar: true,
    icon: logoPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  cashierWindow.loadFile(path.join(__dirname, '..', 'renderer', 'cashier', 'index.html'));
  trackBinding(cashierWindow);
  cashierWindow.on('closed', () => {
    cashierWindow = null;
    if (!adminWindow && !loginWindow && process.platform !== 'darwin') app.quit();
  });
  return cashierWindow;
}

function openAdminWindow() {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.focus();
    return adminWindow;
  }
  adminWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    title: 'لوحة الإدارة — المخزون والمبيعات',
    autoHideMenuBar: true,
    icon: logoPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  adminWindow.loadFile(path.join(__dirname, '..', 'renderer', 'admin', 'index.html'));
  adminWindow.on('closed', () => { adminWindow = null; });
  return adminWindow;
}

function openOwnerWindow() {
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    ownerWindow.focus();
    return ownerWindow;
  }
  ownerWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'مركز التحكم — لوحة المالك',
    autoHideMenuBar: true,
    icon: logoPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  ownerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'owner', 'index.html'));
  ownerWindow.on('closed', () => { ownerWindow = null; });
  return ownerWindow;
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 420,
    height: 600,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'تسجيل الدخول',
    autoHideMenuBar: true,
    icon: logoPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login', 'index.html'));
  loginWindow.on('closed', () => {
    loginWindow = null;
    // Closing the login gate without authenticating exits the app.
    if (!cashierWindow && !adminWindow && process.platform !== 'darwin') app.quit();
  });
  return loginWindow;
}

/* Called by ipc.js after successful auth: move the session from the login
   window onto the newly created POS window, then dismiss the gate. */
function handleAuthSuccess(loginWebContentsId) {
  const posWin = createCashierWindow();
  try {
    auth.copyBinding(loginWebContentsId, posWin.webContents.id);
  } catch { /* session vanished mid-flight; user re-logs */ }
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
}

function handleLogout() {
  for (const w of [cashierWindow, adminWindow, ownerWindow]) {
    if (w && !w.isDestroyed()) w.destroy();
  }
  cashierWindow = null;
  adminWindow = null;
  ownerWindow = null;
  createLoginWindow();
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getAppPath(), 'data', 'pos.db');
  db.init(dbPath);
  auth.init();
  license.init(db.getDb ? db.getDb() : null, app.getPath('userData'));
  license.register();
  console.log('[QAVENO] Database ready at:', dbPath);

  ipc.register(openAdminWindow, {
    onLogin: handleAuthSuccess,
    onLogout: handleLogout
  }, openOwnerWindow);

  createLoginWindow(); // renders first-run owner setup when users table is empty

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLoginWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ── Auto-update (electron-updater) ──────────────────────────────── */
try {
  const { autoUpdater } = require('electron-updater');
  const log = require('electron-log');

  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';

  autoUpdater.on('update-available', (info) => {
    log.info('[QAVENO] Update available:', info.version);
    // Notify all open windows
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('update:available', info);
      }
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('update:progress', progress);
      }
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[QAVENO] Update downloaded:', info.version);
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('update:downloaded', info);
      }
    });
  });

  autoUpdater.on('error', (err) => {
    log.warn('[QAVENO] Auto-update error:', err.message);
  });

  // Check for updates 3 seconds after ready
  app.whenReady().then(() => {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 3000);
  });

  // IPC: manually check for updates
  ipcMain.handle('update:check', () => autoUpdater.checkForUpdates().catch(() => null));
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  // IPC: get current version
  ipcMain.handle('update:version', () => app.getVersion());

} catch { /* electron-updater not available in dev */ }
