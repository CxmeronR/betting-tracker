const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const log = require("electron-log");
const { autoUpdater } = require("electron-updater");

// ─── Logging ───
log.transports.file.level = "info";
autoUpdater.logger = log;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow;
const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // Persist localStorage across sessions (this is default, but explicit)
      partition: "persist:betting-tracker",
    },
    show: false,
  });

  // Graceful show when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    // Open DevTools in dev mode
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Auto Updater Events ───
autoUpdater.on("checking-for-update", () => {
  log.info("Checking for update...");
  sendToWindow("update-status", { status: "checking" });
});

autoUpdater.on("update-available", (info) => {
  log.info("Update available:", info.version);
  sendToWindow("update-status", {
    status: "available",
    version: info.version,
    releaseNotes: info.releaseNotes,
  });
});

autoUpdater.on("update-not-available", () => {
  log.info("No update available");
  sendToWindow("update-status", { status: "up-to-date" });
});

autoUpdater.on("download-progress", (progress) => {
  sendToWindow("update-status", {
    status: "downloading",
    percent: Math.round(progress.percent),
  });
});

autoUpdater.on("update-downloaded", (info) => {
  log.info("Update downloaded:", info.version);
  sendToWindow("update-status", {
    status: "downloaded",
    version: info.version,
  });
  // Prompt user
  if (mainWindow) {
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded.`,
        detail: "The update will be installed when you restart the app.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  }
});

autoUpdater.on("error", (err) => {
  log.error("Auto-updater error:", err);
  sendToWindow("update-status", { status: "error", error: err.message });
});

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── IPC Handlers ───
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("check-for-updates", () => {
  if (!isDev) {
    autoUpdater.checkForUpdates();
  }
  return { isDev };
});
ipcMain.handle("install-update", () => {
  autoUpdater.quitAndInstall();
});

// ─── App Lifecycle ───
app.whenReady().then(() => {
  createWindow();

  // Check for updates after launch (production only)
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.error("Update check failed:", err);
      });
    }, 5000); // 5s delay so the app loads first
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
