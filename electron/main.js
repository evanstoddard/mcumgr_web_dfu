// Electron shell around web/. Serves it from a privileged app:// scheme (ES
// modules + secure context for Web Serial) and replaces Chrome's port chooser,
// which Electron lacks, with an in-page one fed over IPC.
const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB = path.join(__dirname, '..', 'web');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1000, height: 900, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  const ses = win.webContents.session;

  // Pending requestPort(): forward the live port list to the page until it picks.
  let pick = null;
  let ports = [];
  const send = () => win.webContents.send('serial-ports', ports.map((p) => ({
    portId: p.portId, portName: p.portName, displayName: p.displayName,
    vendorId: p.vendorId, productId: p.productId, serialNumber: p.serialNumber,
  })));

  ses.on('select-serial-port', (event, list, _wc, callback) => {
    event.preventDefault();
    pick?.(''); // a newer request supersedes an unanswered one
    pick = callback;
    ports = list;
    send();
  });
  ses.on('serial-port-added', (_e, port) => { ports.push(port); if (pick) send(); });
  ses.on('serial-port-removed', (_e, port) => {
    ports = ports.filter((p) => p.portId !== port.portId);
    if (pick) send();
  });
  ipcMain.on('serial-select', (e, portId) => {
    if (e.sender !== win.webContents || !pick) return;
    pick(portId || '');
    pick = null;
  });

  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler((d) => d.deviceType === 'serial');

  win.loadURL('app://dfu/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = path.normalize(path.join(WEB, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(WEB + path.sep)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
