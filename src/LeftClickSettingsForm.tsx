import React, { useEffect, useState } from 'react';
import { isDebug } from './utility';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    padding: '20px',
    backgroundColor: '#1e1e1e',
    color: '#e1e1e1',
    fontFamily: 'Arial, sans-serif',
    borderRadius: '5px',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.2)',
    maxWidth: '800px',
    margin: '0 auto',
  },
  title: {
    fontSize: '20px',
    fontWeight: 'bold' as 'bold',
    marginBottom: '20px',
    textAlign: 'center' as 'center',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    gap: '15px',
  },
  radioGroup: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    gap: '10px',
    marginBottom: '20px',
  },
  radioOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    cursor: 'pointer',
  },
  radioLabel: {
    fontSize: '14px',
  },
  description: {
    fontSize: '12px',
    color: '#999',
    marginLeft: '26px',
  },
  buttonContainer: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: '20px',
  },
  button: {
    backgroundColor: '#0078d7',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  statusMessage: {
    marginTop: '10px',
    padding: '8px',
    borderRadius: '4px',
    textAlign: 'center' as 'center',
  },
  success: {
    backgroundColor: 'rgba(40, 167, 69, 0.2)',
    border: '1px solid rgba(40, 167, 69, 0.3)',
    color: '#28a745',
  },
  error: {
    backgroundColor: 'rgba(220, 53, 69, 0.2)',
    border: '1px solid rgba(220, 53, 69, 0.3)',
    color: '#dc3545',
  },
};

interface LeftClickSettingsFormProps {
  onClose: () => void;
}

const SERVER_URL = 'http://localhost:55688';

const LeftClickSettingsForm: React.FC<LeftClickSettingsFormProps> = ({
  onClose,
}) => {
  const [leftClickBehavior, setLeftClickBehavior] =
    useState<string>('switcher_window');
  const [status, setStatus] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${SERVER_URL}/ai-assistant-settings`);

      if (response.ok) {
        const settings = await response.json();
        if (settings) {
          setLeftClickBehavior(settings.leftClickBehavior || 'switcher_window');
        }
      } else {
        throw new Error('Failed to fetch settings');
      }
    } catch (error) {
      if (isDebug) {
        console.error('Error fetching settings:', error);
      }
      setStatus({
        message: 'Failed to load settings. Please try again.',
        type: 'error',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      setStatus(null);

      const response = await fetch(`${SERVER_URL}/ai-assistant-settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leftClickBehavior,
        }),
      });

      if (response.ok) {
        setStatus({
          message: 'Settings saved successfully!',
          type: 'success',
        });
      } else {
        throw new Error('Failed to save settings');
      }
    } catch (error) {
      if (isDebug) {
        console.error('Error saving settings:', error);
      }
      setStatus({
        message: 'Failed to save settings. Please try again.',
        type: 'error',
      });
    }
  };

  if (isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Loading settings...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>Left-Click Behavior Settings</div>

      <form style={styles.form} onSubmit={handleSubmit}>
        <div style={styles.radioGroup}>
          <label style={styles.radioOption}>
            <input
              type="radio"
              name="leftClickBehavior"
              value="switcher_window"
              checked={leftClickBehavior === 'switcher_window'}
              onChange={() => setLeftClickBehavior('switcher_window')}
            />
            <span style={styles.radioLabel}>
              Open CodeV Quick Switcher Window
            </span>
          </label>
          <div style={styles.description}>
            The traditional behavior: clicking the menu bar icon opens the CodeV
            Quick Switcher Window.
          </div>

          <label style={styles.radioOption}>
            <input
              type="radio"
              name="leftClickBehavior"
              value="ai_assistant"
              checked={leftClickBehavior === 'ai_assistant'}
              onChange={() => setLeftClickBehavior('ai_assistant')}
            />
            <span style={styles.radioLabel}>Open AI Assistant Insight Chat</span>
          </label>
          <div style={styles.description}>
            Left-clicking the menu bar icon will open the AI Assistant with the
            current clipboard content. You can still access the main window with
            the hotkey Cmd+Ctrl+R.
          </div>

          <label style={styles.radioOption}>
            <input
              type="radio"
              name="leftClickBehavior"
              value="pure_chat"
              checked={leftClickBehavior === 'pure_chat'}
              onChange={() => setLeftClickBehavior('pure_chat')}
            />
            <span style={styles.radioLabel}>Open AI Assistant Smart Chat</span>
          </label>
          <div style={styles.description}>
            Left-clicking the menu bar icon will open the Smart Chat interface
            directly without code. This provides the fastest access to chat with
            Claude. You can still access the CodeV Quick Switcher window with
            Cmd+Ctrl+R and AI Assistant Insight with Cmd+Ctrl+E.
          </div>
        </div>

        <div style={styles.buttonContainer}>
          <button
            type="button"
            onClick={onClose}
            style={{
              ...styles.button,
              backgroundColor: '#6c757d',
              marginRight: '10px',
            }}
          >
            Cancel
          </button>

          <button type="submit" style={styles.button}>
            Save Settings
          </button>
        </div>
      </form>

      {status && (
        <div
          style={{
            ...styles.statusMessage,
            ...(status.type === 'success' ? styles.success : styles.error),
          }}
        >
          {status.message}
        </div>
      )}
    </div>
  );
};

export default LeftClickSettingsForm;
