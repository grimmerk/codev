import React, { useEffect, useState } from 'react';
import { IDEMode } from './ide-enum';
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

interface IDESettingsFormProps {
  onClose: () => void;
}

const SERVER_URL = 'http://localhost:55688';

const IDESettingsForm: React.FC<IDESettingsFormProps> = ({ onClose }) => {
  const [preferredIDE, setPreferredIDE] = useState<string>(IDEMode.VSCode);
  const [status, setStatus] = useState<{
    message: string;
    type: 'success' | 'error';
  } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [ideDataAccessGranted, setIdeDataAccessGranted] = useState(false);

  useEffect(() => {
    fetchSettings();

    (window as any).electronAPI.onIDEDataFolderSelected(
      (_event: any, folderPath: string) => {
        if (folderPath) {
          setIdeDataAccessGranted(true);
        }
      },
    );
  }, []);

  useEffect(() => {
    checkExistingAccess(preferredIDE);
  }, [preferredIDE]);

  const checkExistingAccess = async (ide: string) => {
    const hasAccess = await (window as any).electronAPI.checkIDEDataAccess(ide);
    setIdeDataAccessGranted(hasAccess);
  };

  const fetchSettings = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${SERVER_URL}/ai-assistant-settings`);

      if (response.ok) {
        const settings = await response.json();
        if (settings) {
          setPreferredIDE(settings.preferredIDE || IDEMode.VSCode);
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

  const handleGrantAccess = () => {
    (window as any).electronAPI.openIDEDataSelector(preferredIDE);
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
          preferredIDE,
        }),
      });

      if (response.ok) {
        // Notify main process to apply IDE preference immediately
        (window as any).electronAPI.notifyIDEPreferenceChanged(preferredIDE);
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

  const ideName = preferredIDE === IDEMode.Cursor ? 'Cursor' : 'VS Code';

  return (
    <div style={styles.container}>
      <div style={styles.title}>IDE Preference Settings</div>

      <form style={styles.form} onSubmit={handleSubmit}>
        <div style={styles.radioGroup}>
          <label style={styles.radioOption}>
            <input
              type="radio"
              name="preferredIDE"
              value={IDEMode.VSCode}
              checked={preferredIDE === IDEMode.VSCode}
              onChange={() => setPreferredIDE(IDEMode.VSCode)}
            />
            <span style={styles.radioLabel}>VS Code</span>
          </label>
          <div style={styles.description}>
            Use VS Code for the CodeV Quick Switcher. Opens VS Code when
            selecting a project.
          </div>

          <label style={styles.radioOption}>
            <input
              type="radio"
              name="preferredIDE"
              value={IDEMode.Cursor}
              checked={preferredIDE === IDEMode.Cursor}
              onChange={() => setPreferredIDE(IDEMode.Cursor)}
            />
            <span style={styles.radioLabel}>Cursor</span>
          </label>
          <div style={styles.description}>
            Use Cursor for the CodeV Quick Switcher. Opens Cursor when selecting
            a project.
          </div>
        </div>

        {/* IDE Recent Projects Access Section */}
        <div style={{
          padding: '12px',
          backgroundColor: '#252525',
          borderRadius: '4px',
          marginBottom: '10px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 'bold' as 'bold', marginBottom: '8px' }}>
            Recent Projects Access
          </div>
          <div style={{ fontSize: '12px', color: '#999', marginBottom: '12px' }}>
            Grant access to {ideName}&apos;s data folder so CodeV can read your
            recent projects list. A folder picker will open at the correct folder —
            just click &quot;Open&quot; directly without selecting any file or navigating elsewhere.
          </div>
          <button
            type="button"
            onClick={handleGrantAccess}
            style={{
              ...styles.button,
              backgroundColor: ideDataAccessGranted ? '#28a745' : '#00BCD4',
            }}
          >
            {ideDataAccessGranted ? `${ideName} Access Granted` : `Grant Access to ${ideName} Data`}
          </button>
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

      <div style={{
        marginTop: '15px',
        fontSize: '12px',
        color: '#999',
        textAlign: 'center' as 'center',
        padding: '8px',
        border: '1px dashed #555',
        borderRadius: '4px',
      }}>
        Note: Changes to IDE preference will take effect immediately after saving.
      </div>
    </div>
  );
};

export default IDESettingsForm;
