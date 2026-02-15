const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // App info
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  
  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  installUpdate: (downloadUrl) => ipcRenderer.invoke("install-update", downloadUrl),
  onUpdateStatus: (callback) => {
    ipcRenderer.on("update-status", (_event, data) => callback(data));
    // Return cleanup function
    return () => ipcRenderer.removeAllListeners("update-status");
  },
  
  // Platform detection
  platform: process.platform,
});
