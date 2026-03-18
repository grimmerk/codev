/** Enhanced popup menu for working folder selection and app settings */
import Button from '@atlaskit/button';
import Popup from '@atlaskit/popup';
import { css } from '@emotion/react';
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

const contentStyles = css({
  padding: 15,
  width: 600,
  backgroundColor: '#252525',
  borderRadius: '6px',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
  border: '1px solid #3a3a3a',
});

// Custom button styles
const buttonStyles = {
  default: {
    backgroundColor: THEME.primary,
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    fontWeight: 500,
    '&:hover': {
      backgroundColor: '#0097a7',
    },
  },
  warning: {
    backgroundColor: THEME.button.warning,
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    fontWeight: 500,
    '&:hover': {
      backgroundColor: '#c63737',
    },
  },
  menu: {
    backgroundColor: 'transparent',
    color: THEME.text.primary,
    border: '1px solid #444',
    borderRadius: '4px',
    padding: '6px 12px',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    '&:hover': {
      borderColor: THEME.primary,
      color: THEME.primary,
    },
  },
};

const PopupDefaultExample = ({
  workingFolderPath,
  saveCallback,
  openCallback,
}: {
  workingFolderPath?: string;
  saveCallback?: any;
  openCallback?: any;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [sessionTerminalMode, setSessionTerminalMode] = useState('tab');
  const [sessionDisplayMode, setSessionDisplayMode] = useState('first');

  useEffect(() => {
    (window as any).electronAPI.getAppVersion().then((version: string) => {
      setAppVersion(version);
    });
    (window as any).electronAPI.getSessionTerminalMode().then((mode: string) => {
      setSessionTerminalMode(mode || 'tab');
    });
    (window as any).electronAPI.getSessionDisplayMode().then((mode: string) => {
      setSessionDisplayMode(mode || 'first');
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
      content={(props) => (
        <div
          style={{
            width: 500,
            backgroundColor: '#252525',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            border: '1px solid #3a3a3a',
            overflow: 'hidden', // Ensure no content overflows
          }}
        >
          {/* Header */}
          <div
            style={{
              fontSize: '20px',
              fontWeight: 'bold',
              color: '#ffffff',
              textAlign: 'center',
              padding: '15px 0',
              backgroundColor: '#1e1e1e',
              borderBottom: '1px solid #333',
            }}
          >
            Settings
          </div>

          {/* Working Directory Section */}
          <div
            style={{
              padding: '20px',
            }}
          >
            <div
              style={{
                fontSize: '18px',
                fontWeight: 'bold',
                color: '#ffffff',
                marginBottom: '15px',
              }}
            >
              Working Directory
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: '#1e1e1e',
                padding: '12px 15px',
                borderRadius: '4px',
                border: '1px solid #333',
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  marginRight: '10px',
                  fontSize: '18px',
                  color: THEME.text.folder,
                }}
              >
                📂
              </div>
              <div
                style={{
                  color: '#d0d0d0',
                  fontSize: '15px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                }}
              >
                {workingFolderPath || 'No working folder selected'}
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Button
                appearance="primary"
                onClick={() => {
                  openFolderSelector();
                }}
                style={{
                  backgroundColor: THEME.primary,
                  color: 'white',
                  fontSize: '16px',
                  padding: '10px 20px',
                  minWidth: '180px',
                  borderRadius: '4px',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: '1',
                }}
              >
                Change Folder
              </Button>
            </div>
          </div>

          {/* Launch at Login Section */}
          <div
            style={{
              padding: '0 20px 20px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '15px',
                color: THEME.text.primary,
              }}
            >
              Launch at Login
            </div>
            <label
              style={{
                position: 'relative',
                display: 'inline-block',
                width: '44px',
                height: '24px',
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
                  borderRadius: '12px',
                  transition: 'background-color 0.2s',
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  top: '2px',
                  left: launchAtLogin ? '22px' : '2px',
                  width: '20px',
                  height: '20px',
                  backgroundColor: '#fff',
                  borderRadius: '50%',
                  transition: 'left 0.2s',
                }}
              />
            </label>
          </div>

          {/* Session Terminal Mode */}
          <div
            style={{
              padding: '0 20px 20px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '15px',
                color: THEME.text.primary,
              }}
            >
              Session Terminal
            </div>
            <select
              value={sessionTerminalMode}
              onChange={(e) => {
                const mode = e.target.value;
                setSessionTerminalMode(mode);
                (window as any).electronAPI.setSessionTerminalMode(mode);
              }}
              style={{
                backgroundColor: '#333',
                color: THEME.text.primary,
                border: '1px solid #555',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '13px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="tab">New Tab</option>
              <option value="window">New Window</option>
            </select>
          </div>

          {/* Session Display Mode */}
          <div
            style={{
              padding: '0 20px 20px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                fontSize: '15px',
                color: THEME.text.primary,
              }}
            >
              Session Preview
            </div>
            <select
              value={sessionDisplayMode}
              onChange={(e) => {
                const mode = e.target.value;
                setSessionDisplayMode(mode);
                (window as any).electronAPI.setSessionDisplayMode(mode);
              }}
              style={{
                backgroundColor: '#333',
                color: THEME.text.primary,
                border: '1px solid #555',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '13px',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="first">First Prompt</option>
              <option value="last">Last Prompt</option>
              <option value="both">First + Last</option>
            </select>
          </div>

          {/* App Info and Quit Section */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              backgroundColor: '#1e1e1e',
              padding: '15px 20px',
              borderTop: '1px solid #333',
            }}
          >
            <div
              style={{
                fontSize: '15px',
                fontWeight: '500',
                color: '#888',
              }}
            >
              CodeV v{appVersion}
            </div>

            <Button
              appearance="warning"
              onClick={() => {
                closeAppClick();
              }}
              style={{
                backgroundColor: '#d9534f',
                color: 'white',
                fontSize: '15px',
                fontWeight: 'bold',
                padding: '8px 20px',
                borderRadius: '4px',
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: '1',
              }}
            >
              {'[> Quit CodeV'}
            </Button>
          </div>
        </div>
      )}
      trigger={(triggerProps) => (
        <Button
          {...triggerProps}
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
