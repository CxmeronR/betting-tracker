# Betting Tracker — macOS App

Native macOS desktop app with persistent data storage and automatic updates.

---

## Quick Start (5 minutes)

### Prerequisites
- **Node.js 18+** → [nodejs.org](https://nodejs.org) or `brew install node`
- **Git** → `xcode-select --install` (if not already installed)

### 1. Install dependencies
```bash
cd betting-tracker-app
npm install
```

### 2. Run in development mode
```bash
npm run dev:electron
```
This opens the app in a window with hot-reload. Changes to `src/App.jsx` update instantly.

### 3. Build the macOS app
```bash
npm run build:mac
```
The `.dmg` installer will be in the `release/` folder. Double-click to install.

---

## Data Persistence

**All your data survives app restarts, updates, and rebuilds.** Here's how:

- Data is stored via `localStorage` in Electron's persistent partition
- Physical location: `~/Library/Application Support/Betting Tracker/`
- The `partition: "persist:betting-tracker"` in `electron/main.js` ensures data stays across sessions
- Auto-updates preserve all user data — only the app code changes

### Backup Location
Your localStorage data lives at:
```
~/Library/Application Support/Betting Tracker/Partitions/persist__betting-tracker/Local Storage/
```

### Manual Backup
Use the built-in Backup/Restore feature in the app's Import tab, which exports all data as a JSON file.

---

## Auto-Update System

The app checks for updates on launch and downloads them in the background. When ready, a banner appears offering to restart.

### How It Works
1. You push a version tag to GitHub → `git tag v1.1.0 && git push origin v1.1.0`
2. GitHub Actions builds a new `.dmg` and `.zip` and attaches them to a Release
3. Next time the app launches, `electron-updater` detects the new release
4. Downloads silently in background → prompts user to restart

### Setup (One-Time)

#### 1. Create a GitHub repo
```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/betting-tracker.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

#### 2. Update package.json
Edit `package.json` → find the `"publish"` section and replace:
```json
"publish": {
  "provider": "github",
  "owner": "YOUR_GITHUB_USERNAME",
  "repo": "betting-tracker"
}
```

#### 3. Enable GitHub Actions permissions
- Go to repo → Settings → Actions → General
- Under "Workflow permissions", select **Read and write permissions**
- Check "Allow GitHub Actions to create and approve pull requests"

#### 4. Done! Now push your first release:
```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Pushing Updates

Every time you make changes:

### 1. Make your changes
Edit `src/App.jsx` (or any file).

### 2. Bump the version
```bash
# Edit package.json version field, e.g. "1.0.0" → "1.1.0"
# Or use npm:
npm version patch   # 1.0.0 → 1.0.1 (bug fixes)
npm version minor   # 1.0.0 → 1.1.0 (new features)
npm version major   # 1.0.0 → 2.0.0 (breaking changes)
```

### 3. Push
```bash
git add .
git commit -m "Description of changes"
git push origin main --tags
```

`npm version` automatically creates a git tag. GitHub Actions picks it up, builds the app, and publishes the release. Users get the update next time they open the app.

### Manual Release (Without GitHub Actions)
```bash
npm run build:mac
# Drag the .dmg from release/ to GitHub Releases manually
```

---

## Project Structure

```
betting-tracker-app/
├── package.json            # Dependencies, build config, version
├── vite.config.js          # Vite bundler config
├── index.html              # HTML shell
├── electron/
│   ├── main.js             # Electron main process (window, auto-updater)
│   └── preload.js          # IPC bridge (secure context isolation)
├── src/
│   ├── App.jsx             # ← YOUR BETTING TRACKER (edit this)
│   └── main.jsx            # React entry + update banner UI
├── build/
│   └── icon.svg            # App icon source (convert to .icns for production)
├── scripts/
│   └── generate-icon.sh    # Icon generation helper
└── .github/
    └── workflows/
        └── release.yml     # Auto-build on version tags
```

---

## Optional: Code Signing (Recommended for Distribution)

Without code signing, macOS Gatekeeper will show a warning. To sign:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Create a Developer ID Application certificate
3. Export it as a .p12 file
4. Add these GitHub Secrets:
   - `MAC_CERTIFICATE` — base64-encoded .p12 file
   - `MAC_CERTIFICATE_PASSWORD` — the .p12 password
   - `APPLE_ID` — your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` — [generate here](https://appleid.apple.com/account/manage)
   - `APPLE_TEAM_ID` — your team ID from developer.apple.com
5. Uncomment the signing env vars in `.github/workflows/release.yml`

### Without Code Signing (for personal use)
Right-click the app → Open → "Open Anyway" on first launch. After that it opens normally.

---

## Troubleshooting

**App shows blank white screen:**
→ Run `npm run build` first, then check `dist/index.html` exists.

**"App is damaged" error on macOS:**
→ Run: `xattr -cr /Applications/Betting\ Tracker.app`

**Data disappeared after update:**
→ Shouldn't happen! But if it does, restore from the JSON backup.
→ Data location: `~/Library/Application Support/Betting Tracker/`

**Auto-update not working:**
→ Only works in production builds (not `npm run dev:electron`)
→ Check that your GitHub repo is public (or you have a GH_TOKEN for private repos)
→ Verify the `publish` config in `package.json` matches your repo

**Build fails on Apple Silicon:**
→ Use `npm run build:mac:universal` for universal binary (Intel + Apple Silicon)
