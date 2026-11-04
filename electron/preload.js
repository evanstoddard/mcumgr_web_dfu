const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronSerial', {
  onPorts: (cb) => ipcRenderer.on('serial-ports', (_e, ports) => cb(ports)),
  select: (portId) => ipcRenderer.send('serial-select', portId),
});
