/** Enhanced popup menu for working folder selection and app settings */
import Button from '@atlaskit/button';
import Popup from '@atlaskit/popup';
import { useEffect, useState } from 'react';
import { closeAppClick, openFolderSelector } from './switcher-ui';

// Brand color theme matching app.tsx
const THEME = {
  primary: '#00BCD4',
  text: {
    primary: '#E9E9E9',
    secondary: '#A0A0A0',
    folder: '#6A9955',
  },
  button: {
    primary: '#00BCD4',
    warning: '#e05252',
  },
};

const selectStyle: React.CSSProperties = {
  backgroundColor: '#333',
  color: THEME.text.primary,
  border: '1px solid #555',
  borderRadius: '4px',
  padding: '4px 8px',
  fontSize: '13px',
  cursor: 'pointer',
  outline: 'none',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 16px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '14px',
  color: THEME.text.primary,
};

const PopupDefaultExample = ({
  workingFolderPath,
  saveCallback,
  openCallback,
  switcherMode,
}: {
  workingFolderPath?: string;
  saveCallback?: (key: string, value: string) => void;
  openCallback?: any;
  switcherMode?: string;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [sessionTerminalApp, setSessionTerminalApp] = useState('iterm2');
  const [sessionTerminalMode, setSessionTerminalMode] = useState('tab');
  const [sessionDisplayMode, setSessionDisplayMode] = useState('first');
  const [defaultSwitcherMode, setDefaultSwitcherMode] = useState('projects');
  const [idePreference, setIdePreference] = useState('VSCode');
  const [leftClickBehavior, setLeftClickBehavior] =
    useState('switcher_window');
  const [isMASBuild, setIsMASBuild] = useState(false);
  const [ideDataAccessGranted, setIdeDataAccessGranted] = useState(false);
  const [shortcuts, setShortcuts] = useState({
    quickSwitcher: 'Command+Control+R',
    aiInsight: 'Command+Control+E',
    aiChat: 'Command+Control+C',
  });
  const [editingShortcut, setEditingShortcut] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'>('idle');
  const [updateReleaseName, setUpdateReleaseName] = useState('');
  const [updateTimer, setUpdateTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.electronAPI.getAppVersion().then((version: string) => {
      setAppVersion(version);
    });
    window.electronAPI.getSessionTerminalApp().then((app: string) => {
      setSessionTerminalApp(app || 'iterm2');
    });
    window.electronAPI.getSessionTerminalMode().then((mode: string) => {
      setSessionTerminalMode(mode || 'tab');
    });
    window.electronAPI.getSessionDisplayMode().then((mode: string) => {
      setSessionDisplayMode(mode || 'first');
    });
    window.electronAPI.getDefaultSwitcherMode().then((mode: string) => {
      setDefaultSwitcherMode(mode || 'projects');
    });
    window.electronAPI.getIDEPreference().then((ide: string) => {
      setIdePreference(ide || 'VSCode');
    });
    window.electronAPI
      .getLeftClickBehavior()
      .then((behavior: string) => {
        setLeftClickBehavior(behavior || 'switcher_window');
      });
    window.electronAPI.getIsMAS().then((mas: boolean) => {
      setIsMASBuild(mas);
      if (mas) {
        window.electronAPI.checkIDEDataAccess(idePreference || 'VSCode').then((granted: boolean) => {
          setIdeDataAccessGranted(granted);
        });
      }
    });
    window.electronAPI.getShortcuts().then((s: typeof shortcuts) => {
      if (s) setShortcuts(s);
    });
    window.electronAPI.getUpdateStatus().then((data: any) => {
      if (data) {
        setUpdateStatus(data.status);
        if (data.releaseName) setUpdateReleaseName(data.releaseName);
      }
    });
    window.electronAPI.onUpdateStatus((_event: any, data: any) => {
      setUpdateStatus(data.status);
      if (data.releaseName) setUpdateReleaseName(data.releaseName);
      // Clear timeout when we get a real response
      setUpdateTimer((prev) => { if (prev) clearTimeout(prev); return null; });
    });
  }, []);

  useEffect(() => {
    if (isOpen) {
      window.electronAPI.getLoginItemSettings().then((settings: any) => {
        setLaunchAtLogin(settings.openAtLogin);
      });
    }
  }, [isOpen]);

  const handleLaunchAtLoginChange = (checked: boolean) => {
    setLaunchAtLogin(checked);
    window.electronAPI.setLoginItemSettings(checked);
  };

  const acceleratorToDisplay = (acc: string): string => {
    return acc
      .replace(/Command/g, '\u2318')
      .replace(/Control/g, '\u2303')
      .replace(/Alt/g, '\u2325')
      .replace(/Shift/g, '\u21E7')
      .replace(/\+/g, '+');
  };

  const keyEventToAccelerator = (e: React.KeyboardEvent): string | null => {
    e.preventDefault();
    if (e.key === 'Escape') return null;

    const parts: string[] = [];
    if (e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    if (parts.length === 0) return null;

    let key = e.key;
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
    if (key.length === 1) key = key.toUpperCase();

    parts.push(key);
    return parts.join('+');
  };

  const handleShortcutKeyDown = async (e: React.KeyboardEvent) => {
    if (!editingShortcut) return;
    e.preventDefault();

    if (e.key === 'Escape') {
      // Resume the paused shortcut
      window.electronAPI.resumeShortcut(editingShortcut);
      setEditingShortcut(null);
      setShortcutError('');
      return;
    }

    // Skip if only modifier key pressed
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

    const parts: string[] = [];
    if (e.metaKey) parts.push('Command');
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    if (parts.length === 0) {
      setShortcutError('Need ⌘, ⌃, ⌥, or ⇧');
      return;
    }

    let key = e.key;
    if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    const accelerator = parts.join('+');

    const result = await window.electronAPI.setShortcut(editingShortcut, accelerator);
    if (result.success) {
      setShortcuts((prev) => ({ ...prev, [editingShortcut]: accelerator }));
      setEditingShortcut(null);
      setShortcutError('');
    } else {
      setShortcutError(result.error || 'Failed to set shortcut');
    }
  };

  const handleResetShortcuts = async () => {
    const defaults = await window.electronAPI.resetShortcuts();
    if (defaults) {
      setShortcuts({
        quickSwitcher: defaults.quickSwitcher,
        aiInsight: defaults.aiInsight,
        aiChat: defaults.aiChat,
      });
    }
    setEditingShortcut(null);
    setShortcutError('');
  };

  const triggerUpdateCheck = () => {
    setUpdateStatus('checking');
    if (updateTimer) clearTimeout(updateTimer);
    const timer = setTimeout(() => setUpdateStatus('error'), 30000);
    setUpdateTimer(timer);
    window.electronAPI.checkForUpdate();
  };

  const shortcutRows = [
    { key: 'quickSwitcher', label: 'Quick Switcher' },
    { key: 'aiInsight', label: 'AI Insight' },
    { key: 'aiChat', label: 'AI Chat' },
  ];

  return (
    <Popup
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      placement="bottom-end"
      content={() => (
        <div
          data-settings-panel
          style={{
            width: 420,
            backgroundColor: '#252525',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            border: '1px solid #3a3a3a',
            overflow: 'hidden',
          }}
        >
          <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          {/* Version + Update + Quit — compact top bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 16px', borderBottom: '1px solid #333' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: '#666' }}>v{appVersion}</span>
              {updateStatus === 'idle' && (
                <span
                  onClick={triggerUpdateCheck}
                  style={{ fontSize: '10px', color: THEME.primary, cursor: 'pointer' }}
                >
                  Check for Update
                </span>
              )}
              {updateStatus === 'checking' && (
                <span style={{ fontSize: '10px', color: '#888' }}>Checking...</span>
              )}
              {updateStatus === 'downloading' && (
                <span style={{ fontSize: '10px', color: '#888' }}>Downloading...</span>
              )}
              {updateStatus === 'ready' && (
                <span
                  onClick={() => window.electronAPI.installUpdate()}
                  style={{ fontSize: '10px', color: '#4CAF50', cursor: 'pointer', fontWeight: 600 }}
                >
                  {updateReleaseName ? `${updateReleaseName} ready — ` : ''}Install & Restart
                </span>
              )}
              {updateStatus === 'up-to-date' && (
                <span
                  onClick={triggerUpdateCheck}
                  style={{ fontSize: '10px', color: '#888', cursor: 'pointer' }}
                >
                  Latest ↻
                </span>
              )}
              {updateStatus === 'error' && (
                <span
                  onClick={triggerUpdateCheck}
                  style={{ fontSize: '10px', color: '#e05252', cursor: 'pointer' }}
                >
                  Retry
                </span>
              )}
            </div>
            <span
              onClick={() => closeAppClick()}
              style={{ fontSize: '11px', color: '#CC6666', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Quit
            </span>
          </div>

          {/* General settings (always visible) */}
          <div style={{ padding: '4px 0', borderBottom: '1px solid #333' }}>
            <div style={{ ...rowStyle, padding: '4px 16px' }}>
              <span style={{ ...labelStyle, fontSize: '11px', color: '#888', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>General</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Default Tab</span>
              <select
                value={defaultSwitcherMode}
                onChange={(e) => {
                  const mode = e.target.value;
                  setDefaultSwitcherMode(mode);
                  window.electronAPI.setDefaultSwitcherMode(mode);
                }}
                style={selectStyle}
              >
                <option value="projects">Projects</option>
                <option value="sessions">Sessions</option>
              </select>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Left-Click</span>
              <select
                value={leftClickBehavior}
                onChange={(e) => {
                  const behavior = e.target.value;
                  setLeftClickBehavior(behavior);
                  window.electronAPI.setLeftClickBehavior(behavior);
                }}
                style={selectStyle}
              >
                <option value="switcher_window">Quick Switcher</option>
                <option value="ai_assistant">AI Insight Chat</option>
                <option value="pure_chat">AI Smart Chat</option>
              </select>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Launch at Login</span>
              <label
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: '40px',
                  height: '22px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={launchAtLogin}
                  onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
                  style={{ opacity: 0, width: 0, height: 0 }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: launchAtLogin ? THEME.primary : '#555',
                    borderRadius: '11px',
                    transition: 'background-color 0.2s',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: launchAtLogin ? '20px' : '2px',
                    width: '18px',
                    height: '18px',
                    backgroundColor: '#fff',
                    borderRadius: '50%',
                    transition: 'left 0.2s',
                  }}
                />
              </label>
            </div>
          </div>

          {/* Projects settings (only in Projects tab) */}
          {switcherMode === 'projects' && (
            <div style={{ padding: '4px 0', borderBottom: '1px solid #333' }}>
              <div style={{ ...rowStyle, padding: '4px 16px' }}>
                <span style={{ ...labelStyle, fontSize: '11px', color: '#888', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>Projects</span>
              </div>
              <div style={{ ...rowStyle, gap: '6px' }}>
                <span style={labelStyle}>IDE</span>
                <select
                  value={idePreference}
                  onChange={(e) => {
                    const ide = e.target.value;
                    setIdePreference(ide);
                    window.electronAPI.notifyIDEPreferenceChanged(ide);
                    if (isMASBuild) {
                      window.electronAPI.checkIDEDataAccess(ide).then((granted: boolean) => {
                        setIdeDataAccessGranted(granted);
                      });
                    }
                  }}
                  style={selectStyle}
                >
                  <option value="VSCode">VS Code</option>
                  <option value="Cursor">Cursor</option>
                </select>
                {isMASBuild && (
                  <button
                    onClick={() => window.electronAPI.openIDEDataSelector(idePreference)}
                    style={{
                      backgroundColor: ideDataAccessGranted ? '#28a745' : THEME.primary,
                      color: 'white',
                      border: 'none',
                      borderRadius: '3px',
                      padding: '3px 6px',
                      fontSize: '10px',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {ideDataAccessGranted ? '✓' : 'Grant'}
                  </button>
                )}
              </div>
              <div style={{ ...rowStyle, gap: '8px' }}>
                <span style={labelStyle}>Working Dir</span>
                <div style={{ color: '#aaa', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'right' }}>
                  {workingFolderPath || 'None'}
                </div>
                <button
                  onClick={() => openFolderSelector()}
                  style={{ backgroundColor: 'transparent', border: '1px solid #555', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '12px', color: THEME.text.primary, flexShrink: 0 }}
                  title="Change Folder"
                >
                  📁
                </button>
              </div>
            </div>
          )}

          {/* Sessions settings (only in Sessions tab) */}
          {switcherMode === 'sessions' && (
            <div style={{ padding: '4px 0', borderBottom: '1px solid #333' }}>
              <div style={{ ...rowStyle, padding: '4px 16px' }}>
                <span style={{ ...labelStyle, fontSize: '11px', color: '#888', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>Sessions</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Launch Terminal</span>
                <select
                  value={sessionTerminalApp}
                  onChange={(e) => {
                    const app = e.target.value;
                    setSessionTerminalApp(app);
                    window.electronAPI.setSessionTerminalApp(app);
                  }}
                  style={selectStyle}
                >
                  <option value="iterm2">iTerm2</option>
                  <option value="terminal">Terminal</option>
                  <option value="ghostty">Ghostty</option>
                  <option value="cmux">cmux</option>
                </select>
              </div>
              {(sessionTerminalApp === 'iterm2' || sessionTerminalApp === 'terminal' || sessionTerminalApp === 'ghostty') && (
                <div style={rowStyle}>
                  <span style={labelStyle}>Launch Mode</span>
                  <select
                    value={sessionTerminalMode}
                    onChange={(e) => {
                      const mode = e.target.value;
                      setSessionTerminalMode(mode);
                      window.electronAPI.setSessionTerminalMode(mode);
                    }}
                    style={selectStyle}
                  >
                    <option value="tab">New Tab</option>
                    <option value="window">New Window</option>
                  </select>
                </div>
              )}
              <div style={rowStyle}>
                <span style={labelStyle}>Session Preview</span>
                <select
                  value={sessionDisplayMode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSessionDisplayMode(val);
                    window.electronAPI.setSessionDisplayMode(val);
                    if (saveCallback) saveCallback('sessionDisplayMode', val);
                  }}
                  style={selectStyle}
                >
                  <option value="first">First User Prompt</option>
                  <option value="last">Last User Prompt</option>
                  <option value="both">First + Last</option>
                </select>
              </div>
            </div>
          )}

          {/* Shortcuts section */}
          <div
            style={{
              borderTop: '1px solid #333',
              padding: '10px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '6px',
              }}
            >
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: THEME.text.secondary,
                }}
              >
                Shortcuts
              </span>
              <span
                onClick={handleResetShortcuts}
                style={{
                  fontSize: '11px',
                  color: '#888',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Reset
              </span>
            </div>
            {shortcutRows.map((row) => (
              <div
                key={row.key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '3px 0',
                  gap: '8px',
                }}
              >
                {editingShortcut === row.key ? (
                  <div
                    tabIndex={0}
                    onKeyDown={handleShortcutKeyDown}
                    ref={(el) => el?.focus()}
                    style={{
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      color: shortcutError ? '#e05252' : THEME.primary,
                      backgroundColor: '#333',
                      border: `1px solid ${shortcutError ? '#e05252' : THEME.primary}`,
                      borderRadius: '3px',
                      padding: '2px 6px',
                      minWidth: '90px',
                      textAlign: 'center',
                      outline: 'none',
                      animation: shortcutError ? 'none' : 'pulse 1.5s infinite',
                    }}
                  >
                    {shortcutError || 'Press keys...'}
                  </div>
                ) : (
                  <span
                    style={{
                      fontSize: '12px',
                      color: THEME.text.secondary,
                      fontFamily: 'monospace',
                    }}
                  >
                    {acceleratorToDisplay(shortcuts[row.key as keyof typeof shortcuts])}
                  </span>
                )}
                <span
                  style={{
                    fontSize: '12px',
                    color: THEME.text.secondary,
                    flex: 1,
                  }}
                >
                  {row.label}
                </span>
                <span
                  onClick={() => {
                    if (editingShortcut === row.key) {
                      // Cancel editing — resume the shortcut
                      window.electronAPI.resumeShortcut(row.key);
                      setEditingShortcut(null);
                      setShortcutError('');
                    } else {
                      // Start editing — pause the shortcut so it doesn't trigger
                      if (editingShortcut) {
                        window.electronAPI.resumeShortcut(editingShortcut);
                      }
                      window.electronAPI.pauseShortcut(row.key);
                      setEditingShortcut(row.key);
                      setShortcutError('');
                    }
                  }}
                  style={{
                    fontSize: '11px',
                    color: editingShortcut === row.key ? '#e05252' : THEME.primary,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {editingShortcut === row.key ? 'Cancel' : 'Edit'}
                </span>
              </div>
            ))}
          </div>

        </div>
      )}
      trigger={(triggerProps) => (
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <Button
            {...triggerProps}
            data-settings-panel
            appearance="primary"
            isSelected={isOpen}
            onClick={() => {
              if (openCallback) {
                openCallback();
              }
              setIsOpen(!isOpen);
            }}
            style={{
              backgroundColor: isOpen ? THEME.primary : '#444',
              border: 'none',
              fontSize: '14px',
              fontWeight: 'bold',
              color: '#ffffff',
              padding: '6px 12px',
              borderRadius: '4px',
              transition: 'background-color 0.2s',
              display: 'flex',
              alignItems: 'center',
              lineHeight: '1',
            }}
          >
            Settings
          </Button>
          {updateStatus === 'ready' && !isOpen && (
            <span
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '8px',
                height: '8px',
                backgroundColor: '#4CAF50',
                borderRadius: '50%',
                border: '1.5px solid #1e1e1e',
              }}
            />
          )}
        </div>
      )}
    />
  );
};

export default PopupDefaultExample;
