import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Update notification banner
function UpdateBanner() {
  const [updateStatus, setUpdateStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    // Only wire up if running in Electron
    if (!window.electronAPI) return;

    window.electronAPI.getVersion().then((v) => setAppVersion(v));
    window.electronAPI.checkForUpdates();

    const cleanup = window.electronAPI.onUpdateStatus((data) => {
      setUpdateStatus(data);
      if (data.status === "available" || data.status === "downloaded") {
        setDismissed(false);
      }
    });

    return cleanup;
  }, []);

  if (!updateStatus || dismissed) return null;
  if (updateStatus.status === "up-to-date" || updateStatus.status === "checking") return null;
  if (updateStatus.status === "error") return null;

  const bannerStyle = {
    position: "fixed",
    bottom: 20,
    right: 20,
    zIndex: 999999,
    background: "linear-gradient(135deg, rgba(0,230,138,0.12), rgba(0,230,138,0.04))",
    border: "1px solid rgba(0,230,138,0.3)",
    borderRadius: 14,
    padding: "12px 18px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    backdropFilter: "blur(20px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    maxWidth: 380,
    fontFamily: "'Inter', -apple-system, sans-serif",
  };

  const btnStyle = {
    background: "rgba(0,230,138,0.15)",
    border: "1px solid rgba(0,230,138,0.4)",
    borderRadius: 8,
    padding: "6px 14px",
    color: "#00e68a",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  if (updateStatus.status === "downloading") {
    return (
      <div style={bannerStyle}>
        <div style={{ fontSize: 18, flexShrink: 0 }}>⬇️</div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8" }}>Downloading update...</div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{updateStatus.percent}% complete</div>
          <div style={{ height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${updateStatus.percent}%`, background: "#00e68a", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      </div>
    );
  }

  if (updateStatus.status === "downloaded") {
    return (
      <div style={bannerStyle}>
        <div style={{ fontSize: 18, flexShrink: 0 }}>✅</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8" }}>Update v{updateStatus.version} ready</div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Restart to apply</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => window.electronAPI?.installUpdate()} style={btnStyle}>Restart</button>
          <button onClick={() => setDismissed(true)} style={{ ...btnStyle, background: "transparent", borderColor: "rgba(255,255,255,0.15)", color: "#888" }}>Later</button>
        </div>
      </div>
    );
  }

  if (updateStatus.status === "available") {
    return (
      <div style={bannerStyle}>
        <div style={{ fontSize: 18, flexShrink: 0 }}>🔄</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e8e8" }}>Update v{updateStatus.version} available</div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Downloading in background...</div>
        </div>
        <button onClick={() => setDismissed(true)} style={{ ...btnStyle, background: "transparent", borderColor: "rgba(255,255,255,0.15)", color: "#888" }}>✕</button>
      </div>
    );
  }

  return null;
}

function Root() {
  return (
    <>
      <App />
      <UpdateBanner />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
