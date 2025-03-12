/** Enhanced popup menu for working folder selection and app settings */
import Button from '@atlaskit/button';
import Popup from '@atlaskit/popup';
import { css } from '@emotion/react';
import { useState } from 'react';
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
              CodeV v1.0
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
