const {app, BrowserWindow, Menu, dialog, shell} = require('electron');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const run = promisify(execFile);
const origin = 'http://127.0.0.1:8766';
app.setName('Arko Workspace');
app.setDesktopName('qwen-review.desktop');
app.commandLine.appendSwitch('class', 'ArkoWorkspace');
app.setPath('userData', process.env.ARKO_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'arko-workspace'));
let window, poll, token, quitting = false;
function external(url) {
  try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}
async function serverReady() {
  await run('systemctl', ['--user', 'start', 'local-qwen-review.service']);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(origin + '/api/bootstrap', {signal:AbortSignal.timeout(1500)});
      if (response.ok) { token = (await response.json()).token; return; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Arko Workspace could not start. Check the local-qwen-review user service.');
}
async function openWindow() {
  const statePath = path.join(app.getPath('userData'), 'window.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  window = new BrowserWindow({width:saved.width || 1440, height:saved.height || 960,
    minWidth:760, minHeight:600, title:'Arko Workspace', backgroundColor:'#232323',
    icon:path.join(__dirname, '..', 'workspace', 'assets', 'arko-icon.png'),
    webPreferences:{contextIsolation:true, nodeIntegration:false, sandbox:true}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Arko', submenu:[{role:'quit'}]},
    {label:'Edit', submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'View', submenu:[{role:'reload'},{role:'togglefullscreen'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'toggleDevTools'}]}
  ]));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents.getURL().startsWith(origin + '/') && permission === 'clipboard-sanitized-write');
  });
  window.webContents.setWindowOpenHandler(({url}) => {external(url); return {action:'deny'};});
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {event.preventDefault(); external(url);}
  });
  window.on('close', () => {
    const bounds = window.getNormalBounds();
    const hash = new URL(window.webContents.getURL() || origin).hash;
    fs.mkdirSync(app.getPath('userData'), {recursive:true});
    fs.writeFileSync(statePath, JSON.stringify({...bounds, maximized:window.isMaximized(), hash}), {mode:0o600});
  });
  if (saved.maximized) window.maximize();
  await window.loadURL(origin + (/^#(implement|map|preview|changes|archify)$/.test(saved.hash) ? saved.hash : '/#implement'));
  poll = setInterval(async () => {
    if (quitting || !window || window.isDestroyed()) return;
    try {
      const response = await fetch(origin + '/api/bootstrap', {signal:AbortSignal.timeout(1500)});
      if (!response.ok) return;
      const current = (await response.json()).token;
      if (token && current !== token) window.webContents.reload();
      token = current;
    } catch {}
  }, 3000);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {if (window) {if (window.isMinimized()) window.restore(); window.focus();}});
  app.whenReady().then(serverReady).then(openWindow).catch(error => {dialog.showErrorBox('Arko Workspace', error.message); app.quit();});
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {quitting=true; clearInterval(poll);});
}
