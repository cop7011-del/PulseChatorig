const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

process.env.PORT = process.env.PORT || '4000';

let mainWindow;
let serverStarted = false;

function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  // Start the existing server in-process
  require(path.join(__dirname, 'server', 'index.js'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1220',
    title: 'PulseChat',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = `http://localhost:${process.env.PORT}/pulse.html`;
  const load = () => mainWindow.loadURL(url).catch(() => setTimeout(load, 500));
  setTimeout(load, 600);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) { shell.openExternal(target); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
