# Electron 29 → 41 Migration Notes

## HIGH IMPACT

### Electron 33: macOS 10.15 (Catalina) dropped
- Minimum macOS is now 11 (Big Sur)

### Electron 33: Native modules require C++20
- `node-gyp` builds need `--std=c++20` (affects Swift CopyTool bridge if compiled)

### Electron 33: `WebFrameMain` detachment
- `event.senderFrame` in IPC handlers can be `null` if accessed after `await`
- **Action**: access `event.senderFrame` synchronously at top of IPC handlers

### Electron 38: macOS 11 (Big Sur) dropped
- Minimum macOS is now 12 (Monterey)

## MEDIUM IMPACT

### Electron 35: `session.setPreloads()` deprecated
- Replace with `session.registerPreloadScript()`

### Electron 40: `clipboard` deprecated in renderer
- Our `clipboard.readText()` is in main process → **not affected**

## NOT AFFECTED (confirmed safe)

| API | Status |
|-----|--------|
| BrowserWindow | No breaking changes |
| globalShortcut | No breaking changes |
| ipcMain / ipcRenderer | Core API unchanged (watch `senderFrame` in v33) |
| Tray | No breaking changes |
| process.mas | Still works |
| contextBridge | No breaking changes |
| Preload scripts | Still work (`setPreloads` deprecation in v35) |

## RECOMMENDED PATH

1. 29 → 33: Handle `senderFrame`, C++20, drop Catalina
2. 33 → 35: Update `setPreloads` if used
3. 35 → 38: Drop Big Sur
4. 38 → 41: Mostly safe

## electron-forge

`@electron-forge/plugin-webpack` still works with Electron 41. Vite is the new recommended direction but webpack plugin not deprecated.
