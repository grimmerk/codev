/** Type definitions for the Electron IPC API exposed via preload.ts */

type IpcCallback = (event: Electron.IpcRendererEvent, ...args: any[]) => void;

interface IElectronAPI {
  // App actions
  invokeVSCode: (path: string, option: string) => void;
  hideApp: () => void;
  openFolderSelector: () => void;
  closeAppClick: () => void;
  popupAlert: (alert: string) => void;
  searchWorkingFolder: (path: string) => void;

  // IDE data
  openIDEDataSelector: (idePath: string) => void;
  onIDEDataFolderSelected: (callback: IpcCallback) => void;
  checkIDEDataAccess: (ideMode: string) => Promise<boolean>;
  notifyIDEPreferenceChanged: (preferredIDE: string) => void;
  getIDEPreference: () => Promise<string>;
  getIsMAS: () => Promise<boolean>;
  getLeftClickBehavior: () => Promise<string>;
  setLeftClickBehavior: (behavior: string) => void;

  // App version & update
  getAppVersion: () => Promise<string>;
  checkForUpdate: () => void;
  installUpdate: () => void;
  getUpdateStatus: () => Promise<{ status: string; releaseName?: string; error?: string } | null>;
  onUpdateStatus: (callback: IpcCallback) => void;

  // Session terminal settings
  getSessionTerminalApp: () => Promise<string>;
  setSessionTerminalApp: (app: string) => void;
  getSessionTerminalMode: () => Promise<string>;
  setSessionTerminalMode: (mode: string) => void;
  getSessionDisplayMode: () => Promise<string>;
  setSessionDisplayMode: (mode: string) => void;
  getDefaultSwitcherMode: () => Promise<string>;
  setDefaultSwitcherMode: (mode: string) => void;
  getLoginItemSettings: () => Promise<{ openAtLogin: boolean }>;
  setLoginItemSettings: (openAtLogin: boolean) => void;

  // Claude Code sessions
  getClaudeSessions: (limit?: number) => Promise<any>;
  searchClaudeSessions: (query: string) => Promise<any>;
  detectActiveSessions: () => Promise<Record<string, number>>;
  detectTerminalApps: (pidMap: Record<string, number>) => Promise<Record<string, string>>;
  openClaudeSession: (sessionId: string, projectPath: string, isActive: boolean, activePid?: number, customTitle?: string) => void;
  copyClaudeSessionCommand: (sessionId: string, projectPath: string) => void;
  loadSessionEnrichment: (sessions: any[]) => Promise<{ titles: Record<string, string>; branches: Record<string, string> }>;
  loadLastAssistantResponses: (sessions: any[]) => Promise<Record<string, string>>;
  loadProjectBranches: (paths: string[]) => Promise<Record<string, string>>;

  // VS Code SQLite
  fetchVSCodeBasedIDESqlite: () => void;
  onVSCodeBasedSqliteRead: (callback: IpcCallback) => void;
  deleteVSCodeBasedIDESqliteRecord: (path: string) => void;
  onVSCodeBasedSqliteRecordDeleted: (callback: IpcCallback) => void;

  // Window events
  onFolderSelected: (callback: IpcCallback) => void;
  onWorkingFolderIterated: (callback: IpcCallback) => void;
  onFocusWindow: (callback: IpcCallback) => void;
  onXWinNotFound: (callback: IpcCallback) => void;

  // AI Assistant insight events
  onCodeToGenerateInsight: (callback: IpcCallback) => void;
  onAIAssistantInsightStart: (callback: IpcCallback) => void;
  onAIAssistantInsightChunk: (callback: IpcCallback) => void;
  onAIAssistantInsightComplete: (callback: IpcCallback) => void;
  onAIAssistantInsightError: (callback: IpcCallback) => void;
  onDetectedLanguage: (callback: IpcCallback) => void;
  onSkipInsight: (callback: IpcCallback) => void;

  // UI mode
  notifyAIAssistantInsightCompleted?: (completed: boolean) => void;
  notifyInsightCompleted?: (completed: boolean) => void;
  onSetUIMode: (callback: IpcCallback) => void;
  notifyUIMode: (mode: string) => void;
  onLoadLatestConversation: (callback: IpcCallback) => void;
  onFindConversationByCode: (callback: IpcCallback) => void;

  // Chat
  sendChatMessage: (message: string, messageHistory: any[], additionalContext?: any) => void;
  onChatResponse: (callback: IpcCallback) => void;
  onChatResponseStart: (callback: IpcCallback) => void;
  onChatResponseChunk: (callback: IpcCallback) => void;
  onChatResponseComplete: (callback: IpcCallback) => void;
  onChatResponseError: (callback: IpcCallback) => void;
  onChatConversationSaved: (callback: IpcCallback) => void;

  // Settings windows
  onOpenAIAssistantSettings: (callback: IpcCallback) => void;
  onOpenApiKeySettings: (callback: IpcCallback) => void;
  onOpenLeftClickSettings: (callback: IpcCallback) => void;
  onOpenIDESettings: (callback: IpcCallback) => void;

  // Conversation history
  saveConversation: (conversation: any) => Promise<any>;
  updateConversation: (id: string, conversation: any) => Promise<any>;
  getConversation: (id: string) => Promise<any>;
  getConversations: (params: any) => Promise<any>;
  getLatestConversation: (isFromCode?: boolean) => Promise<any>;
  deleteConversation: (id: string) => Promise<any>;
  addMessageToConversation: (id: string, message: any) => Promise<any>;
  searchConversations: (searchTerm: string) => Promise<any>;

  // Keyboard shortcuts
  getShortcuts: () => Promise<{ quickSwitcher: string; aiInsight: string; aiChat: string }>;
  setShortcut: (key: string, accelerator: string) => Promise<{ success: boolean; error?: string }>;
  resetShortcuts: () => Promise<{ quickSwitcher: string; aiInsight: string; aiChat: string }>;
  pauseShortcut: (key: string) => Promise<void>;
  resumeShortcut: (key: string) => Promise<void>;

  // Legacy aliases (ai-assistant-ui.tsx compatibility)
  onInsightStart?: (callback: IpcCallback) => void;
  onInsightChunk?: (callback: IpcCallback) => void;
  onInsightComplete?: (callback: IpcCallback) => void;
  onInsightError?: (callback: IpcCallback) => void;
}

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}

export {};
