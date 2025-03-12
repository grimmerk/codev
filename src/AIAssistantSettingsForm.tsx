import React, { useEffect, useState } from 'react';
import { isDebug } from './utility';

import { DEFAULT_AI_ASSISTANT_PROMPT } from './ai-assistant-prompt';

// Default prompt to show in form is imported from ai-assistant-prompt.ts

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
  label: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    gap: '5px',
    fontSize: '14px',
  },
  textarea: {
    backgroundColor: '#2d2d2d',
    border: '1px solid #444',
    borderRadius: '4px',
    padding: '10px',
    color: '#e1e1e1',
    fontFamily: 'monospace',
    fontSize: '14px',
    lineHeight: '1.4',
    minHeight: '300px',
    resize: 'vertical' as 'vertical',
  },
  input: {
    backgroundColor: '#2d2d2d',
    border: '1px solid #444',
    borderRadius: '4px',
    padding: '8px',
    color: '#e1e1e1',
    fontFamily: 'Arial, sans-serif',
    fontSize: '14px',
  },
  buttonContainer: {
    display: 'flex',
    justifyContent: 'space-between',
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
  resetButton: {
    backgroundColor: '#d74c0e',
  },
  infoText: {
    fontSize: '12px',
    color: '#999',
    marginTop: '5px',
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

interface AIAssistantSettingsFormProps {
  onClose: () => void;
}

const SERVER_URL = 'http://localhost:55688';

const AIAssistantSettingsForm: React.FC<AIAssistantSettingsFormProps> = ({
  onClose,
}) => {
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
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
          setCustomPrompt(settings.customPrompt ?? DEFAULT_AI_ASSISTANT_PROMPT);
          setApiKey(settings.apiKey || '');
          setLeftClickBehavior(settings.leftClickBehavior || 'switcher_window');
        } else {
          setCustomPrompt(DEFAULT_AI_ASSISTANT_PROMPT);
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
      setCustomPrompt(DEFAULT_AI_ASSISTANT_PROMPT);
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
          customPrompt,
          apiKey,
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

  const handleReset = () => {
    setCustomPrompt(DEFAULT_AI_ASSISTANT_PROMPT);
    setStatus(null);
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
      <div style={styles.title}>AI Assistant Settings</div>

      <form style={styles.form} onSubmit={handleSubmit}>
        <label style={styles.label}>
          Custom Prompt Template for Getting Insight:
          <textarea
            style={styles.textarea}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Enter your custom prompt template..."
          />
          <div style={styles.infoText}>
            Use {'{selected_text}'} as a placeholder for the code or text to be
            analyzed.
            <br />
            <span
              style={{
                marginTop: '5px',
                fontStyle: 'italic',
                display: 'block',
              }}
            >
              Note: If the prompt template is empty, the app will immediately
              open in chat mode with your selected code, without generating an
              AI insight. This is useful for directly asking questions about
              your code.
            </span>
          </div>
        </label>

        <div style={styles.buttonContainer}>
          <button
            type="button"
            onClick={handleReset}
            style={{ ...styles.button, ...styles.resetButton }}
          >
            Reset to Default
          </button>

          <div>
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

export default AIAssistantSettingsForm;
