// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getHomeDir: () => ipcRenderer.sendSync('get-home-dir'),
  invokeVSCode: (path: string, option: string) =>
    ipcRenderer.send('invoke-vscode', path, option),

  hideApp: () => ipcRenderer.send('hide-app'),
  openFolderSelector: () => ipcRenderer.send('open-folder-selector'),
  closeAppClick: () => ipcRenderer.send('close-app-click'),
  popupAlert: (alert: string) => ipcRenderer.send('pop-alert', alert),
  searchWorkingFolder: (path: string) =>
    ipcRenderer.send('search-working-folder', path),

  openIDEDataSelector: (idePath: string) =>
    ipcRenderer.send('open-ide-data-selector', idePath),
  onIDEDataFolderSelected: (callback: any) =>
    ipcRenderer.on('ide-data-folder-selected', callback),
  checkIDEDataAccess: (ideMode: string) => ipcRenderer.invoke('check-ide-data-access', ideMode),
  notifyIDEPreferenceChanged: (preferredIDE: string) => ipcRenderer.send('ide-preference-changed', preferredIDE),
  getIDEPreference: () => ipcRenderer.invoke('get-ide-preference'),
  getIsMAS: () => ipcRenderer.invoke('get-is-mas'),
  getLeftClickBehavior: () => ipcRenderer.invoke('get-left-click-behavior'),
  setLeftClickBehavior: (behavior: string) => ipcRenderer.send('set-left-click-behavior', behavior),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.send('check-for-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  onUpdateStatus: (callback: any) => ipcRenderer.on('update-status', callback),
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  setAppMode: (mode: string) => ipcRenderer.send('set-app-mode', mode),
  onAppModeChanged: (callback: any) => ipcRenderer.on('app-mode-changed', callback),
  onShortcutsUpdated: (callback: any) => ipcRenderer.on('shortcuts-updated', callback),
  getSessionTerminalApp: () => ipcRenderer.invoke('get-session-terminal-app'),
  setSessionTerminalApp: (app: string) => ipcRenderer.send('set-session-terminal-app', app),
  getSessionTerminalMode: () => ipcRenderer.invoke('get-session-terminal-mode'),
  setSessionTerminalMode: (mode: string) => ipcRenderer.send('set-session-terminal-mode', mode),
  getSessionDisplayMode: () => ipcRenderer.invoke('get-session-display-mode'),
  setSessionDisplayMode: (mode: string) => ipcRenderer.send('set-session-display-mode', mode),
  getDefaultSwitcherMode: () => ipcRenderer.invoke('get-default-switcher-mode'),
  setDefaultSwitcherMode: (mode: string) => ipcRenderer.send('set-default-switcher-mode', mode),
  getLoginItemSettings: () => ipcRenderer.invoke('get-login-item-settings'),
  setLoginItemSettings: (openAtLogin: boolean) => ipcRenderer.send('set-login-item-settings', openAtLogin),

  // Session status hooks
  getSessionStatusHooksEnabled: () => ipcRenderer.invoke('get-session-status-hooks-enabled'),
  setSessionStatusHooksEnabled: (enabled: boolean) => ipcRenderer.send('set-session-status-hooks-enabled', enabled),
  getSessionStatuses: () => ipcRenderer.invoke('get-session-statuses'),
  onSessionStatusesUpdated: (callback: any) => ipcRenderer.on('session-statuses-updated', callback),

  // Claude Code session APIs
  getClaudeSessions: (limit?: number) => ipcRenderer.invoke('get-claude-sessions', limit),
  searchClaudeSessions: (query: string) => ipcRenderer.invoke('search-claude-sessions', query),
  detectActiveSessions: () => ipcRenderer.invoke('detect-active-sessions'),
  detectTerminalApps: (pidMap: Record<string, number>, entrypointMap?: Record<string, string>) => ipcRenderer.invoke('detect-terminal-apps', pidMap, entrypointMap),
  scanClosedVSCodeSessions: (activeSessionIds: string[]) => ipcRenderer.invoke('scan-closed-vscode-sessions', activeSessionIds),
  refreshSessionPreview: (sessions: any[]) => ipcRenderer.invoke('refresh-session-preview', sessions),
  openClaudeSession: (sessionId: string, projectPath: string, isActive: boolean, activePid?: number, customTitle?: string) =>
    ipcRenderer.send('open-claude-session', sessionId, projectPath, isActive, activePid, customTitle),
  launchNewClaudeSession: (projectPath: string) =>
    ipcRenderer.send('launch-new-claude-session', projectPath),
  launchNewClaudeSessionInCodev: (projectPath: string) =>
    ipcRenderer.send('launch-new-claude-session-in-codev', projectPath),
  copyClaudeSessionCommand: (sessionId: string, projectPath: string) =>
    ipcRenderer.send('copy-claude-session-command', sessionId, projectPath),
  loadSessionEnrichment: (sessions: any[]) => ipcRenderer.invoke('load-session-enrichment', sessions),
  loadLastAssistantResponses: (sessions: any[]) => ipcRenderer.invoke('load-last-assistant-responses', sessions),
  loadProjectBranches: (paths: string[]) => ipcRenderer.invoke('load-project-branches', paths),
  detectActiveIDEProjects: () => ipcRenderer.invoke('detect-active-ide-projects'),

  /** for reading VS Code built-in sqlite */
  fetchVSCodeBasedIDESqlite: () => ipcRenderer.send('fetch-vscode-based-sqlite'),
  onVSCodeBasedSqliteRead: (callback: any) =>
    ipcRenderer.on('vscode-based-sqlite-read', callback),
  deleteVSCodeBasedIDESqliteRecord: (path: string) => ipcRenderer.send('delete-vscode-based-sqlite-record', path),
  onVSCodeBasedSqliteRecordDeleted: (callback: any) =>
    ipcRenderer.on('vscode-based-sqlite-record-deleted', callback),
  

  onFolderSelected: (callback: any) =>
    ipcRenderer.on('folder-selected', callback),

  onWorkingFolderIterated: (callback: any) =>
    ipcRenderer.on('working-folder-iterated', callback),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onFocusWindow: (callback: any) => ipcRenderer.on('window-focus', callback),
  onSwitchToTerminal: (callback: any) => ipcRenderer.on('switch-to-terminal', callback),
  onCheckTerminalAndHide: (callback: any) => ipcRenderer.on('check-terminal-and-hide', callback),
  onXWinNotFound: (callback: any) => ipcRenderer.on('xwin-not-found', callback),

  // Listen for code to explain in the ai assistant window
  onCodeToGenerateInsight: (callback: any) =>
    ipcRenderer.on('code-to-generate-insight', callback),

  // Streaming explanation events
  onAIAssistantInsightStart: (callback: any) =>
    ipcRenderer.on('ai-assistant-insight-start', callback),
  onAIAssistantInsightChunk: (callback: any) =>
    ipcRenderer.on('ai-assistant-insight-chunk', callback),
  onAIAssistantInsightComplete: (callback: any) =>
    ipcRenderer.on('ai-assistant-insight-complete', callback),
  onAIAssistantInsightError: (callback: any) =>
    ipcRenderer.on('ai-assistant-insight-error', callback),
  onDetectedLanguage: (callback: any) =>
    ipcRenderer.on('detected-language', callback),
  onSkipInsight: (callback: any) =>
    ipcRenderer.on('skip-ai-assistant-insight', callback),

  // UI mode control
  notifyAIAssistantInsightCompleted: (completed: boolean) =>
    ipcRenderer.send('ai-assistant-insight-completed', completed),
  onSetUIMode: (callback: any) => ipcRenderer.on('set-ui-mode', callback),
  notifyUIMode: (mode: string) => ipcRenderer.send('ui-mode-changed', mode),
  onLoadLatestConversation: (callback: any) => ipcRenderer.on('load-latest-conversation', callback),
  onFindConversationByCode: (callback: any) => ipcRenderer.on('find-conversation-by-code', callback),

  // Chat-related events and methods
  sendChatMessage: (message: string, messageHistory: any[], additionalContext?: any) =>
    ipcRenderer.send('send-chat-message', message, messageHistory, additionalContext),
  onChatResponse: (callback: any) => ipcRenderer.on('chat-response', callback),
  onChatResponseStart: (callback: any) =>
    ipcRenderer.on('chat-response-start', callback),
  onChatResponseChunk: (callback: any) =>
    ipcRenderer.on('chat-response-chunk', callback),
  onChatResponseComplete: (callback: any) =>
    ipcRenderer.on('chat-response-complete', callback),
  onChatResponseError: (callback: any) =>
    ipcRenderer.on('chat-response-error', callback),
  onChatConversationSaved: (callback: any) =>
    ipcRenderer.on('chat-conversation-saved', callback),

  // Settings windows events
  onOpenAIAssistantSettings: (callback: any) =>
    ipcRenderer.on('open-ai-assistant-settings', callback),
  onOpenApiKeySettings: (callback: any) =>
    ipcRenderer.on('open-api-key-settings', callback),
  onOpenLeftClickSettings: (callback: any) =>
    ipcRenderer.on('open-left-click-settings', callback),
  onOpenIDESettings: (callback: any) =>
    ipcRenderer.on('open-ide-settings', callback),
    
  // Conversation history APIs
  saveConversation: (conversation: any) => 
    ipcRenderer.invoke('save-conversation', conversation),
  updateConversation: (id: string, conversation: any) => 
    ipcRenderer.invoke('update-conversation', id, conversation),
  getConversation: (id: string) => 
    ipcRenderer.invoke('get-conversation', id),
  getConversations: (params: any) => 
    ipcRenderer.invoke('get-conversations', params),
  getLatestConversation: (isFromCode?: boolean) => 
    ipcRenderer.invoke('get-latest-conversation', isFromCode),
  deleteConversation: (id: string) => 
    ipcRenderer.invoke('delete-conversation', id),
  addMessageToConversation: (id: string, message: any) => 
    ipcRenderer.invoke('add-message-to-conversation', id, message),
  searchConversations: (searchTerm: string) =>
    ipcRenderer.invoke('search-conversations', searchTerm),

  // Custom keyboard shortcuts
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  setShortcut: (key: string, accelerator: string) => ipcRenderer.invoke('set-shortcut', key, accelerator),
  resetShortcuts: () => ipcRenderer.invoke('reset-shortcuts'),
  pauseShortcut: (key: string) => ipcRenderer.invoke('pause-shortcut', key),
  resumeShortcut: (key: string) => ipcRenderer.invoke('resume-shortcut', key),

  // Terminal (node-pty + xterm.js)
  terminalGetCwd: () => ipcRenderer.invoke('terminal-get-cwd'),
  terminalSpawn: (options: { cwd?: string; cols?: number; rows?: number }) => ipcRenderer.send('terminal-spawn', options),
  terminalAttach: (cols: number, rows: number) => ipcRenderer.send('terminal-attach', cols, rows),
  terminalInput: (data: string) => ipcRenderer.send('terminal-input', data),
  terminalResize: (cols: number, rows: number) => ipcRenderer.send('terminal-resize', cols, rows),
  terminalIsSpawned: () => ipcRenderer.invoke('terminal-is-spawned'),
  terminalKill: () => ipcRenderer.send('terminal-kill'),
  onTerminalData: (callback: any) => ipcRenderer.on('terminal-data', callback),
  onTerminalExit: (callback: any) => ipcRenderer.on('terminal-exit', callback),
});

// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
// window.addEventListener("DOMContentLoaded", () => {
//   const replaceText = (selector: string, text: string) => {
//     const element = document.getElementById(selector);
//     if (element) {
//       element.innerText = text;
//     }
//   };

//   for (const type of ["chrome", "node", "electron"]) {
//     replaceText(`${type}-version`, process.versions[type as keyof NodeJS.ProcessVersions]);
//   }
// });
