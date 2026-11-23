'use strict';
/*
 * Desktop shell for Code Studio. It starts the local launcher (server.js) with the compilers that ship
 * inside the installer, then shows the interface in a normal window. All the real work stays in server.js.
 */
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 32180;              // its own port, so it never collides with the browser version on 32121
const START_TIMEOUT_MS = 90_000; // first start probes every compiler, which can take a while
const APP_DIR = path.join(__dirname, '..');
const TOOLCHAINS = app.isPackaged ? path.join(process.resourcesPath, 'toolchains') : path.join(APP_DIR, 'toolchains');

let server = null;
let win = null;
let origin = null;
let quitting = false;
let logStream = null;

const LOADING_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Code Studio</title>
<body style="margin:0;height:100vh;display:grid;place-content:center;background:#0b1020;color:#e8eef8;font:16px system-ui,sans-serif;text-align:center">
<div style="width:56px;height:56px;margin:0 auto 18px;border-radius:16px;display:grid;place-content:center;background:linear-gradient(145deg,#6ba5ff,#6958d8);font-weight:900;font-size:24px">CS</div>
<div>Starting Code Studio…</div><div style="color:#8ea1bb;font-size:13px;margin-top:8px">Checking the compilers</div></body>`);

function log(text) {
  try {
    if (!logStream) {
      fs.mkdirSync(app.getPath('logs'), { recursive: true });
      logStream = fs.createWriteStream(path.join(app.getPath('logs'), 'launcher.log'), { flags: 'w' });
    }
    logStream.write(text);
  } catch { /* logging is best effort */ }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js'), '--no-open', `--port=${PORT}`, '--exit-with-parent'], {
      cwd: APP_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODESTUDIO_TOOLCHAINS: TOOLCHAINS },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server = child;
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('The launcher did not start in time.')); } }, START_TIMEOUT_MS);
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      log(text);
      if (settled) return;
      buffer += text;
      const m = /running at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(buffer);
      if (m) { settled = true; clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code) => {
      server = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`The launcher stopped unexpectedly (code ${code}).`)); }
      else if (!quitting) {
        dialog.showErrorBox('Code Studio stopped', 'The background service closed unexpectedly. Please reopen Code Studio.');
        app.quit();
      }
    });
  });
}

function stopServer() {
  const child = server;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(); }, 4000);
    child.once('exit', done);
    try { child.stdin.end(); } catch { try { child.kill(); } catch { /* already gone */ } }
  });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b1020', title: 'Code Studio', show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // Links that leave the app open in the normal browser; the app never navigates away from itself.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (url.startsWith('data:text/html')) return;
    if (!origin || !url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  return win.loadURL(LOADING_PAGE);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    buildMenu();
    await createWindow();
    try {
      origin = await startServer();
      if (win) await win.loadURL(origin);
    } catch (e) {
      log(`\n${e.stack || e.message}\n`);
      dialog.showErrorBox('Code Studio could not start',
        `${e.message}\n\nPlease close Code Studio and open it again. If it keeps happening, reinstall it.\n\nDetails were saved to:\n${path.join(app.getPath('logs'), 'launcher.log')}`);
      quitting = true;
      await stopServer();
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (server) { event.preventDefault(); stopServer().then(() => app.quit()); }
  });
  app.on('activate', () => { if (!win && origin) createWindow().then(() => win && win.loadURL(origin)); });
}
