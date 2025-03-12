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
  label: {
    display: 'flex',
    flexDirection: 'column' as 'column',
    gap: '5px',
    fontSize: '14px',
  },
  input: {
    backgroundColor: '#2d2d2d',
    border: '1px solid #444',
    borderRadius: '4px',
    padding: '10px',
    color: '#e1e1e1',
    fontFamily: 'monospace',
    fontSize: '14px',
    lineHeight: '1.4',
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
  clearButton: {
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

interface ApiKeySettingsFormProps {
  onClose: () => void;
}

const SERVER_URL = 'http://localhost:55688';

const ApiKeySettingsForm: React.FC<ApiKeySettingsFormProps> = ({ onClose }) => {
  const [apiKey, setApiKey] = useState<string>('');
  const [status, setStatus] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [defaultApiKey, setDefaultApiKey] = useState<string>('');

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
          setApiKey(settings.apiKey || '');

          // Also fetch default API key from environment for display
          try {
            const envResponse = await fetch(`${SERVER_URL}/app/env-api-key`);
            if (envResponse.ok) {
              const { apiKey: envApiKey } = await envResponse.json();
              setDefaultApiKey(envApiKey || '');
            }
          } catch (err) {
            if (isDebug) {
              console.error('Error fetching default API key:', err);
            }
          }
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
          apiKey,
        }),
      });

      if (response.ok) {
        setStatus({
          message: 'API Key saved successfully!',
          type: 'success',
        });
      } else {
        throw new Error('Failed to save API Key');
      }
    } catch (error) {
      if (isDebug) {
        console.error('Error saving API Key:', error);
      }
      setStatus({
        message: 'Failed to save API Key. Please try again.',
        type: 'error',
      });
    }
  };

  const handleClear = () => {
    setApiKey('');
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
      <div style={styles.title}>API Key Settings</div>

      <form style={styles.form} onSubmit={handleSubmit}>
        <label style={styles.label}>
          Your Anthropic API Key:
          <input
            type="password"
            style={styles.input}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your Anthropic API key..."
          />
          <div style={styles.infoText}>
            {defaultApiKey
              ? 'A default API key is already configured in the environment. Your custom key will override it if provided.'
              : 'No default API key was found. You must provide your own API key to use the AI Assistant.'}
          </div>
        </label>

        <div style={styles.buttonContainer}>
          <button
            type="button"
            onClick={handleClear}
            style={{ ...styles.button, ...styles.clearButton }}
          >
            Clear
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
              Save API Key
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

export default ApiKeySettingsForm;
