const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const log = require("electron-log");
const https = require("https");
const fs = require("fs");

// ─── Logging ───
log.transports.file.level = "info";

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
      partition: "persist:betting-tracker",
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Manual Update Check (no Squirrel) ───
function checkForUpdate() {
  const currentVersion = app.getVersion();
  log.info(`Checking for updates... current: ${currentVersion}`);
  sendToWindow("update-status", { status: "checking" });

  const options = {
    hostname: "api.github.com",
    path: "/repos/CxmeronR/betting-tracker/releases/latest",
    headers: { "User-Agent": "betting-tracker-app" },
  };

  https.get(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const release = JSON.parse(data);
        const latestVersion = (release.tag_name || "").replace(/^v/, "");
        log.info(`Latest version: ${latestVersion}`);

        if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
          // Find the DMG asset
          const dmgAsset = (release.assets || []).find((a) => a.name.endsWith(".dmg"));
          const downloadUrl = dmgAsset
            ? dmgAsset.browser_download_url
            : release.html_url;

          log.info(`Update available: ${latestVersion}, url: ${downloadUrl}`);
          sendToWindow("update-status", {
            status: "available",
            version: latestVersion,
            downloadUrl,
            releaseNotes: release.body || "",
          });
        } else {
          log.info("No update available");
          sendToWindow("update-status", { status: "up-to-date" });
        }
      } catch (e) {
        log.error("Failed to parse release info:", e);
        sendToWindow("update-status", { status: "error", error: e.message });
      }
    });
  }).on("error", (e) => {
    log.error("Update check failed:", e);
    sendToWindow("update-status", { status: "error", error: e.message });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ─── IPC Handlers ───
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("check-for-updates", () => {
  if (!isDev) {
    checkForUpdate();
  }
  return { isDev };
});
ipcMain.handle("install-update", (event, downloadUrl) => {
  // Open the DMG download URL in the browser
  if (downloadUrl) {
    shell.openExternal(downloadUrl);
  }
});

// ─── App Lifecycle ───
app.whenReady().then(() => {
  createWindow();

  if (!isDev) {
    setTimeout(() => {
      checkForUpdate();
    }, 5000);
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
