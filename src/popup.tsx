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

  useEffect(() => {
    (window as any).electronAPI.getAppVersion().then((version: string) => {
      setAppVersion(version);
    });
    (window as any).electronAPI.getSessionTerminalApp().then((app: string) => {
      setSessionTerminalApp(app || 'iterm2');
    });
    (window as any).electronAPI.getSessionTerminalMode().then((mode: string) => {
      setSessionTerminalMode(mode || 'tab');
    });
    (window as any).electronAPI.getSessionDisplayMode().then((mode: string) => {
      setSessionDisplayMode(mode || 'first');
    });
    (window as any).electronAPI.getDefaultSwitcherMode().then((mode: string) => {
      setDefaultSwitcherMode(mode || 'projects');
    });
    (window as any).electronAPI.getIDEPreference().then((ide: string) => {
      setIdePreference(ide || 'VSCode');
    });
    (window as any).electronAPI
      .getLeftClickBehavior()
      .then((behavior: string) => {
        setLeftClickBehavior(behavior || 'switcher_window');
      });
  }, []);

  useEffect(() => {
    if (isOpen) {
      (window as any).electronAPI.getLoginItemSettings().then((settings: any) => {
        setLaunchAtLogin(settings.openAtLogin);
      });
    }
  }, [isOpen]);

  const handleLaunchAtLoginChange = (checked: boolean) => {
    setLaunchAtLogin(checked);
    (window as any).electronAPI.setLoginItemSettings(checked);
  };

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
          {/* Working Directory - single row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 16px',
              backgroundColor: '#1e1e1e',
              borderBottom: '1px solid #333',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '16px', flexShrink: 0 }}>📂</span>
            <div
              style={{
                color: '#d0d0d0',
                fontSize: '13px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flex: 1,
              }}
            >
              {workingFolderPath || 'No working folder selected'}
            </div>
            <button
              onClick={() => openFolderSelector()}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid #555',
                borderRadius: '4px',
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: '1',
                flexShrink: 0,
                color: THEME.text.primary,
              }}
              title="Change Folder"
            >
              📁
            </button>
          </div>

          {/* Settings rows */}
          <div style={{ padding: '8px 0' }}>
            {/* Default Tab */}
            {switcherMode === 'sessions' && (
              <>
                <div style={rowStyle}>
                  <span style={labelStyle}>Default Tab</span>
                  <select
                    value={defaultSwitcherMode}
                    onChange={(e) => {
                      const mode = e.target.value;
                      setDefaultSwitcherMode(mode);
                      (window as any).electronAPI.setDefaultSwitcherMode(mode);
                    }}
                    style={selectStyle}
                  >
                    <option value="projects">Projects</option>
                    <option value="sessions">Sessions</option>
                  </select>
                </div>

                {/* Launch Terminal */}
                <div style={rowStyle}>
                  <span style={labelStyle}>Launch Terminal</span>
                  <select
                    value={sessionTerminalApp}
                    onChange={(e) => {
                      const app = e.target.value;
                      setSessionTerminalApp(app);
                      (window as any).electronAPI.setSessionTerminalApp(app);
                    }}
                    style={selectStyle}
                  >
                    <option value="iterm2">iTerm2</option>
                    <option value="ghostty">Ghostty</option>
                    <option value="cmux">cmux</option>
                  </select>
                </div>

                {/* Launch Mode (for iTerm2 and Ghostty) */}
                {(sessionTerminalApp === 'iterm2' ||
                  sessionTerminalApp === 'ghostty') && (
                  <div style={rowStyle}>
                    <span style={labelStyle}>Launch Mode</span>
                    <select
                      value={sessionTerminalMode}
                      onChange={(e) => {
                        const mode = e.target.value;
                        setSessionTerminalMode(mode);
                        (window as any).electronAPI.setSessionTerminalMode(mode);
                      }}
                      style={selectStyle}
                    >
                      <option value="tab">New Tab</option>
                      <option value="window">New Window</option>
                    </select>
                  </div>
                )}

                {/* Session Preview */}
                <div style={rowStyle}>
                  <span style={labelStyle}>Session Preview</span>
                  <select
                    value={sessionDisplayMode}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSessionDisplayMode(val);
                      (window as any).electronAPI.setSessionDisplayMode(val);
                      if (saveCallback) saveCallback('sessionDisplayMode', val);
                    }}
                    style={selectStyle}
                  >
                    <option value="first">First User Prompt</option>
                    <option value="last">Last User Prompt</option>
                    <option value="both">First + Last</option>
                  </select>
                </div>
              </>
            )}

            {/* IDE Preference */}
            <div style={rowStyle}>
              <span style={labelStyle}>IDE</span>
              <select
                value={idePreference}
                onChange={(e) => {
                  const ide = e.target.value;
                  setIdePreference(ide);
                  (window as any).electronAPI.notifyIDEPreferenceChanged(ide);
                }}
                style={selectStyle}
              >
                <option value="VSCode">VS Code</option>
                <option value="Cursor">Cursor</option>
              </select>
            </div>

            {/* Left-Click Behavior */}
            <div style={rowStyle}>
              <span style={labelStyle}>Left-Click</span>
              <select
                value={leftClickBehavior}
                onChange={(e) => {
                  const behavior = e.target.value;
                  setLeftClickBehavior(behavior);
                  (window as any).electronAPI.setLeftClickBehavior(behavior);
                }}
                style={selectStyle}
              >
                <option value="switcher_window">Quick Switcher</option>
                <option value="ai_assistant">AI Insight Chat</option>
                <option value="pure_chat">AI Smart Chat</option>
              </select>
            </div>

            {/* Launch at Login */}
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

          {/* Shortcuts section */}
          <div
            style={{
              borderTop: '1px solid #333',
              padding: '10px 16px',
            }}
          >
            <div
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: THEME.text.secondary,
                marginBottom: '6px',
              }}
            >
              Shortcuts
            </div>
            {[
              { keys: '\u2303+\u2318+R', label: 'Quick Switcher' },
              { keys: '\u2303+\u2318+E', label: 'AI Insight' },
              { keys: '\u2303+\u2318+C', label: 'AI Chat' },
            ].map((shortcut) => (
              <div
                key={shortcut.keys}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '3px 0',
                }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    color: THEME.text.secondary,
                    fontFamily: 'monospace',
                  }}
                >
                  {shortcut.keys}
                </span>
                <span
                  style={{
                    fontSize: '12px',
                    color: THEME.text.secondary,
                  }}
                >
                  {shortcut.label}
                </span>
              </div>
            ))}
          </div>

          {/* Version + Quit - single row */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#1e1e1e',
              padding: '10px 16px',
              borderTop: '1px solid #333',
            }}
          >
            <span
              style={{
                fontSize: '13px',
                color: '#666',
              }}
            >
              v{appVersion}
            </span>
            <button
              onClick={() => closeAppClick()}
              style={{
                backgroundColor: THEME.button.warning,
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '5px 14px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Quit CodeV
            </button>
          </div>
        </div>
      )}
      trigger={(triggerProps) => (
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
      )}
    />
  );
};

export default PopupDefaultExample;
