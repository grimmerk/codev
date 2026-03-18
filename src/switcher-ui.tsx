import { VSWindow as VSWindowModel } from '@prisma/client';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import Highlighter from 'react-highlight-words';
import Select, { components, OptionProps } from 'react-select';
import { HoverButton } from './HoverButton';
import PopupDefaultExample from './popup';

type SwitcherMode = 'projects' | 'sessions';
// import { fetchVSCodeBasedOpenedWindows, SERVER_URL, deleteRecentProjectRecord } from "./vscode-based-ide-utility"
export const SERVER_URL = 'http://localhost:55688';

// Global styles for the switcher UI (moved from index.css)
const globalStyles = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica,
      Arial, sans-serif;
    margin: 0;
    padding: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  #switcher-root {
    height: 100vh;
    width: 100vw;
    padding: 0;
    margin: 0;
  }
`;

// Apply global styles
const styleElement = document.createElement('style');
styleElement.innerHTML = globalStyles;
document.head.appendChild(styleElement);

function invokeVSCode(path: string, optionPress = false) {
  // press option for VSCode -r --reuse-window
  // Force to open a file or folder in an already opened window.
  const option = `${optionPress ? '-r ' : ''}`;
  (window as any).electronAPI.invokeVSCode(`${path}`, option);
}

function hideApp() {
  (window as any).electronAPI.hideApp();
}

function searchWorkingFolder(path: string) {
  (window as any).electronAPI.searchWorkingFolder(path);
}

export function openFolderSelector() {
  (window as any).electronAPI.openFolderSelector();
}

export function closeAppClick() {
  (window as any).electronAPI.closeAppClick();
}

export function fetchVSCodeBasedIDESqlite() {
  (window as any).electronAPI.fetchVSCodeBasedIDESqlite();
}
export function deleteVSCodeBasedIDESqliteRecord(path: string) {
  console.log('ui deleteVSCodeBasedIDESqliteRecord:');

  (window as any).electronAPI.deleteVSCodeBasedIDESqliteRecord(path);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fetchWorkingFolder = async (): Promise<{
  id: number;
  workingFolder?: string;
}> => {
  const url = `${SERVER_URL}/user`;
  const resp = await fetch(url);
  const json = await resp.json();
  return json;
};

const saveWorkingFolder = async (workingFolder: string) => {
  const url = `${SERVER_URL}/user`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const resp = await fetch(url, {
    body: JSON.stringify({ workingFolder }),
    method: 'POST',
    headers,
  });
  const json = await resp.json();
  return json;
};

// const retryFetchRecentProjectRecord = async (): Promise<void> => {
//   if (isDebug) {
//     console.log('retryFetchData');
//   }
// fetchVSCodeBasedIDESqlite();
// const url = `${SERVER_URL}/xwins`;
// let retryTimes = 20;
// let succeed = false;
// let json: VSWindowModel[] = [];
// while (!succeed && retryTimes > 0) {
//   try {
//     // at least 6/5*50 milliseconds needed for serve start time
//     // most of the times are 7 or 6 times
//     if (isDebug && retryTimes != 20) {
//       console.log('retrying fetchData');
//     }
//     // const resp = await fetch(url);
//     // json = await resp.json();
//     /** TODO: add this back */
//     // json = await fetchVSCodeBasedOpenedWindows();
//     succeed = true;
//   } catch (err) {
//     retryTimes -= 1;
//     await sleep(50);
//   }
// }
// return json;
// };

const OPTION_KEY = 18;

// Brand color theme - Based on CodeV app icon's turquoise color
const THEME = {
  primary: '#00BCD4', // Turquoise, main brand color
  text: {
    primary: '#E9E9E9', // Light text for dark background
    secondary: '#A0A0A0', // Grey text for paths
    newItem: '#6A9955', // Green for unopened items
  },
  background: {
    hover: '#3a3a3a', // Hover background color
    selected: '#064f61', // Selected item background color
  },
};

/** Enhanced option label formatter - horizontal layout for higher information density */
const formatOptionLabel = (
  {
    value,
    label,
    everOpened,
  }: { value: string; label: string; everOpened: boolean },
  { inputValue }: { inputValue: string },
) => {
  // Split input into search words
  const searchWords = (inputValue ?? '')
    .split(' ')
    .filter((sub: string) => sub);

  // Extract path and name
  const path = label?.slice(0, label.lastIndexOf('/'));
  let name = label?.slice(label.lastIndexOf('/') + 1);
  name = name?.replace(/\.code-workspace/, ' (Workspace)');

  // Determine styles based on whether the item has been opened
  const nameStyle: any = {
    fontWeight: '500',
    fontSize: '15px', // Increased font size
    minWidth: '180px', // Fixed width for project names for better alignment
    paddingRight: '10px',
  };

  const pathStyle: any = {
    fontSize: '14px', // Increased font size
    color: THEME.text.secondary,
    flex: 1,
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  };

  if (!everOpened) {
    nameStyle.color = THEME.text.newItem;
  } else {
    nameStyle.color = THEME.text.primary;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '2px 0',
        width: '100%',
        height: '30px', // Increased height for better readability
      }}
    >
      <div style={nameStyle}>
        <Highlighter
          searchWords={searchWords}
          textToHighlight={name}
          highlightStyle={{
            backgroundColor: 'rgba(0, 188, 212, 0.2)',
            color: '#fff',
            padding: '0 2px',
            borderRadius: '2px',
          }}
        />
      </div>
      <div style={pathStyle}>
        <Highlighter
          searchWords={searchWords}
          textToHighlight={path}
          highlightStyle={{
            backgroundColor: 'rgba(0, 188, 212, 0.1)',
            color: '#ccc',
            padding: '0 2px',
            borderRadius: '2px',
          }}
        />
      </div>
    </div>
  );
};

export interface SelectInputOptionInterface {
  readonly value: string;
  readonly label: string;
  isDisabled: boolean;
  isSelected: boolean;
}

// Enhanced Option component with improved styling and hover effects
const OptionUI: FC<OptionProps<SelectInputOptionInterface>> = (
  props,
  onDeleteClick,
) => {
  const { selectOption, selectProps, data, isSelected, isFocused } = props;
  const { value, label } = data;

  return (
    <div
      key={value}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '2px 8px',
        margin: '2px 0',
        borderRadius: '3px',
        backgroundColor: isSelected
          ? THEME.background.selected
          : isFocused
            ? THEME.background.hover
            : 'transparent',
        transition: 'background-color 0.2s ease',
        cursor: 'pointer',
        height: '34px', // Increased height to match item height
      }}
    >
      <components.Option {...props} />
      <div>
        <HoverButton
          width={22}
          height={22}
          onClick={(e) => {
            e.stopPropagation(); // Prevent triggering selection
            if (onDeleteClick) {
              onDeleteClick(data);
            }
          }}
        >
          ✕
        </HoverButton>
      </div>
    </div>
  );
};

/** Format relative time for session display */
const formatRelativeTime = (timestamp: string): string => {
  if (!timestamp) return '';
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

/** Caution it will be invoked twice due to <React.StrictMode> !! */
let loadTimes = 0;
function SwitcherApp() {
  const optionPress = useRef(false);

  const ref = useRef(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const forceFocusOnInput = () => {
    if (mode === 'projects') {
      ref.current?.focus();
    } else {
      sessionSearchRef.current?.focus();
    }
  };

  const [mode, setMode] = useState<SwitcherMode>('projects');
  const [inputValue, setInputValue] = useState('');
  const [sessionSearchValue, setSessionSearchValue] = useState('');
  const [selectedOptions, setSelectedOptions] = useState([]);
  const [pathInfoArray, setPathInfoArray] = useState<VSWindowModel[]>([]);
  const [workingFolderPath, setWorkingFolderPath] = useState('');
  const [workingPathInfoArray, setWorkingPathInfoArray] = useState<string[]>(
    [],
  );
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [sessionDisplayMode, setSessionDisplayMode] = useState('first');
  const modeRef = useRef<SwitcherMode>('projects');

  const updateWorkingPathUIAndList = async (path: string) => {
    setWorkingFolderPath(path);

    if (path) {
      searchWorkingFolder(path);
    }
  };

  const fetchRecentProjectRecord = async () => {
    fetchVSCodeBasedIDESqlite(); //retryFetchRecentProjectRecord();
  };

  const fetchClaudeSessions = async () => {
    const result = await (window as any).electronAPI.getClaudeSessions(100);
    setSessions(result || []);
  };

  const fetchWorkingFolderAndUpdate = async () => {
    const user = await fetchWorkingFolder();
    updateWorkingPathUIAndList(user.workingFolder);
  };

  useEffect(() => {
    if (loadTimes > 0) {
      return;
    }
    loadTimes += 1;

    function handleKeyDown(e: any) {
      // 93: cmd. 18:option
      if (e.keyCode === OPTION_KEY) {
        optionPress.current = true;
      }
      // Tab to toggle between projects and sessions
      if (e.key === 'Tab') {
        e.preventDefault();
        const newMode = modeRef.current === 'projects' ? 'sessions' : 'projects';
        modeRef.current = newMode;
        setMode(newMode);
        if (newMode === 'sessions') {
          fetchClaudeSessions();
        }
      }
    }
    function handleKeyUp(e: any) {
      if (e.keyCode === OPTION_KEY) {
        optionPress.current = false;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('click', (e) => {
      forceFocusOnInput();
    });

    (window as any).electronAPI.onFocusWindow((_event: any) => {
      fetchRecentProjectRecord();
      fetchWorkingFolderAndUpdate();
      if (modeRef.current === 'sessions') {
        fetchClaudeSessions();
      }
      // Refresh display mode setting
      (window as any).electronAPI.getSessionDisplayMode().then((mode: string) => {
        setSessionDisplayMode(mode || 'first');
      });
    });

    (window as any).electronAPI.onWorkingFolderIterated(
      async (_event: any, paths: string[]) => {
        setWorkingPathInfoArray(paths);
      },
    );

    (window as any).electronAPI.onXWinNotFound((_event: any) => {
      /** currently the popup message is done by electron native UI */
    });

    (window as any).electronAPI.onFolderSelected(
      async (_event: any, folderPath: string) => {
        if (!folderPath) {
          return;
        }

        const resp = await saveWorkingFolder(folderPath);
        if (resp?.status === 'ok') {
          updateWorkingPathUIAndList(folderPath);
        } else {
          /**
           * roll back to old path
           * NOTE: show some alert
           */
          (window as any).electronAPI.popupAlert('failed to save');
        }
      },
    );

    (window as any).electronAPI.onVSCodeBasedSqliteRead(
      async (_event: any, recentProject: VSWindowModel[]) => {
        setPathInfoArray(recentProject);
      },
    );
    (window as any).electronAPI.onVSCodeBasedSqliteRecordDeleted(
      async (_event: any) => {
        fetchRecentProjectRecord();
      },
    );

    /** pros: query one time in early stage
     * cons: it may need to retry when it is starting
     * also onFocusWindow will be triggered when the 1st time cmd +ctrl +r is used
     * redundant
     */
    /** onFocusWindow will trigger it, buf if we use cmd + w to close it,
     * then we must call it here, onFocusWindow will not be triggered in that case
     */
    fetchRecentProjectRecord();
    fetchWorkingFolderAndUpdate();

    // Don't forget to clean up
    return function cleanup() {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const openPathSet = new Set();
  const openPathArray = pathInfoArray.map((pathInfo) => {
    const { path } = pathInfo;
    openPathSet.add(path);
    return {
      value: path,
      label: path,
      everOpened: true,
    };
  });

  const workingInfoArray: Array<{
    value: string;
    label: string;
    everOpened: boolean;
  }> = [];
  workingPathInfoArray.forEach((path: string) => {
    if (!openPathSet.has(path)) {
      workingInfoArray.push({
        value: path,
        label: path,
        everOpened: false,
      });
    }
  });
  // if (openPathArray?.length) {
  const pathArray = openPathArray.concat(workingInfoArray);
  // console.log('before set pathArray:', pathArray.length);
  // console.log({
  //   openPathArray: openPathArray.length,
  //   workingPathInfoArray: workingPathInfoArray.length,
  //   pathArray: pathArray.length,
  // });

  const onDeleteClick = useCallback(
    async (data: { everOpened: boolean; label: string; value: string }) => {
      const { value } = data;
      /** TODO: add this back */
      // await deleteRecentProjectRecord(value);
      deleteVSCodeBasedIDESqliteRecord(value);
    },
    [],
  );

  const filterOptions = (
    candidate: {
      label: string;
      value: string;
      data: {
        everOpened: boolean;
        label: string;
        value: string;
      };
    },
    input: string,
  ) => {
    // console.log("filterOptions:", candidate?.data)
    let allFound = true;

    let target: string;
    try {
      target = candidate?.value?.toLowerCase();
    } catch (err) {
      console.log('target:', candidate);
    }

    if (input) {
      const inputArray = input.toLowerCase().split(' ');
      for (const subInput of inputArray) {
        if (subInput) {
          if (!target?.includes(subInput)) {
            allFound = false;
            break;
          }
        }
      }
    } else {
      return true;
    }

    // false means all filtered (not match)
    return allFound;
  };

  return (
    <div
      style={{
        backgroundColor: '#1a1a1a',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 15px',
          borderBottom: '1px solid #333',
          backgroundColor: '#252525',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            color: THEME.text.primary,
            fontWeight: 'bold',
            fontSize: '16px',
          }}
        >
          <span
            style={{
              color: THEME.primary,
              marginRight: '8px',
              fontSize: '18px',
            }}
          >
            {mode === 'projects' ? '📂' : '🤖'}
          </span>
          CodeV Quick Switcher
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              display: 'flex',
              backgroundColor: '#333',
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            <button
              onClick={() => { modeRef.current = 'projects'; setMode('projects'); }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: mode === 'projects' ? THEME.primary : 'transparent',
                color: mode === 'projects' ? '#fff' : THEME.text.secondary,
                transition: 'background-color 0.2s',
              }}
            >
              Projects
            </button>
            <button
              onClick={() => { modeRef.current = 'sessions'; setMode('sessions'); fetchClaudeSessions(); }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: mode === 'sessions' ? THEME.primary : 'transparent',
                color: mode === 'sessions' ? '#fff' : THEME.text.secondary,
                transition: 'background-color 0.2s',
              }}
            >
              Sessions
            </button>
          </div>
          <PopupDefaultExample
            workingFolderPath={workingFolderPath}
            saveCallback={(key: string, value: string) => {
              if (key === 'sessionDisplayMode') {
                setSessionDisplayMode(value);
              }
            }}
          />
        </div>
      </div>

      {mode === 'sessions' ? (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <input
            ref={sessionSearchRef}
            value={sessionSearchValue}
            onChange={async (e) => {
              const val = e.target.value;
              setSessionSearchValue(val);
              if (val.trim()) {
                const result = await (window as any).electronAPI.searchClaudeSessions(val);
                setSessions(result || []);
              } else {
                fetchClaudeSessions();
              }
              setSelectedSessionIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (sessionSearchValue) {
                  setSessionSearchValue('');
                  fetchClaudeSessions();
                } else {
                  hideApp();
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSessionIndex((i) => Math.min(i + 1, sessions.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSessionIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && sessions[selectedSessionIndex]) {
                const s = sessions[selectedSessionIndex];
                (window as any).electronAPI.openClaudeSession(s.sessionId, s.project, s.isActive, s.activePid);
              }
            }}
            placeholder="Search sessions..."
            autoFocus
            style={{
              backgroundColor: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '4px',
              padding: '10px 12px',
              margin: '10px 15px',
              color: THEME.text.primary,
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
            {sessions.length === 0 ? (
              <div style={{ color: THEME.text.secondary, textAlign: 'center', padding: '20px 0' }}>
                {sessionSearchValue ? '⚠️ No matching sessions found' : '🤖 No Claude Code sessions found'}
              </div>
            ) : (
              sessions.map((session, index) => (
                <div
                  key={session.sessionId}
                  onClick={() => {
                    (window as any).electronAPI.openClaudeSession(session.sessionId, session.project, session.isActive, session.activePid);
                  }}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 10px',
                    margin: '2px 0',
                    borderRadius: '3px',
                    backgroundColor: index === selectedSessionIndex ? THEME.background.hover : 'transparent',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                  }}
                  onMouseEnter={() => setSelectedSessionIndex(index)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {session.isActive && (
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#4CAF50', flexShrink: 0 }} />
                      )}
                      <span style={{ fontWeight: '500', fontSize: '15px', color: THEME.text.primary }}>
                        <Highlighter
                          searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                          textToHighlight={session.projectName}
                          highlightStyle={{
                            backgroundColor: 'rgba(0, 188, 212, 0.2)',
                            color: '#fff',
                            padding: '0 2px',
                            borderRadius: '2px',
                          }}
                        />
                      </span>
                      {(sessionDisplayMode === 'first' || sessionDisplayMode === 'both') && (
                        <span style={{ color: '#b0b0b0', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          · <Highlighter
                            searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                            textToHighlight={(session.firstUserMessage || '').slice(0, sessionDisplayMode === 'both' ? 40 : 60)}
                            highlightStyle={{
                              backgroundColor: 'rgba(0, 188, 212, 0.1)',
                              color: '#ccc',
                              padding: '0 2px',
                              borderRadius: '2px',
                            }}
                          />
                        </span>
                      )}
                      {(sessionDisplayMode === 'last' || sessionDisplayMode === 'both') && session.lastUserMessage && (sessionDisplayMode === 'last' || session.lastUserMessage !== session.firstUserMessage) && (
                        <span style={{ color: '#e8a946', fontSize: sessionDisplayMode === 'both' ? '12px' : '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sessionDisplayMode === 'both' ? ' → ' : '· '}
                          <Highlighter
                            searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                            textToHighlight={(session.lastUserMessage || '').slice(0, sessionDisplayMode === 'both' ? 30 : 60)}
                            highlightStyle={{
                              backgroundColor: 'rgba(232, 169, 70, 0.15)',
                              color: '#e8a946',
                              padding: '0 2px',
                              borderRadius: '2px',
                            }}
                          />
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, marginLeft: '10px' }}>
                    <span style={{ color: THEME.text.secondary, fontSize: '12px' }}>
                      {session.messageCount} msgs
                    </span>
                    <span style={{ color: THEME.text.secondary, fontSize: '12px' }}>
                      {formatRelativeTime(session.lastTimestamp)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
      <Select
        filterOption={filterOptions}
        ref={ref}
        noOptionsMessage={() => {
          if (pathArray.length > 0) {
            return '⚠️ No matching projects found';
          }
          return '📂 No projects available';
        }}
        menuIsOpen={true}
        autoFocus={true}
        maxMenuHeight={500}
        inputValue={inputValue}
        value={selectedOptions}
        openMenuOnFocus={true}
        placeholder="Search projects..."
        classNamePrefix="codev-select"
        onKeyDown={(evt) => {
          if (evt.key === 'Tab') {
            evt.preventDefault();
            evt.stopPropagation();
            modeRef.current = 'sessions';
            setMode('sessions');
            fetchClaudeSessions();
            return;
          }
          // here first, then handleKeyDown
          if (evt.key == 'Escape') {
            // this will prevent "handleKeyDown"
            evt.stopPropagation();
            // it will prevent esc to empty input but still pass to handleKeyDown
            evt.preventDefault();

            if (inputValue) {
              setInputValue('');
            } else {
              // hide this app
              hideApp();
            }
          }
        }}
        onInputChange={(evt) => {
          setInputValue(evt);
        }}
        onChange={(evt: any) => {
          invokeVSCode(evt.value, optionPress.current);
          /** in this case, when invokeVSCode triggers this ui to be hided,
           * there will no keyup event triggered to reset optionPress.current,
           * so we reset here */
          optionPress.current = false;
        }}
        // Custom components
        components={{
          DropdownIndicator: null,
          Option: (props) => OptionUI(props, onDeleteClick),
        }}
        formatOptionLabel={formatOptionLabel}
        options={pathArray}
        styles={{
          control: (base) => ({
            ...base,
            backgroundColor: '#2d2d2d',
            borderColor: '#444',
            borderRadius: '4px',
            boxShadow: 'none',
            '&:hover': {
              borderColor: THEME.primary,
            },
            padding: '4px',
            margin: '10px 15px',
          }),
          input: (base) => ({
            ...base,
            color: THEME.text.primary,
            fontSize: '14px',
          }),
          menu: (base) => ({
            ...base,
            backgroundColor: 'transparent',
            boxShadow: 'none',
            margin: '0',
          }),
          menuList: (base) => ({
            ...base,
            backgroundColor: 'transparent',
            padding: '0 6px',
            margin: '0 6px',
            maxHeight: '480px', // Increased max height for more items
          }),
          option: (base) => ({
            ...base,
            backgroundColor: 'transparent',
            cursor: 'pointer',
            padding: 0,
            margin: 0,
            height: '34px', // Increased height for better readability
          }),
          noOptionsMessage: (base) => ({
            ...base,
            color: THEME.text.secondary,
            textAlign: 'center',
            padding: '20px 0',
          }),
        }}
      />
      )}
    </div>
  );
}

export default SwitcherApp;

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
  const root = ReactDOM.createRoot(document.getElementById('switcher-root'));
  root.render(<SwitcherApp />);

  console.log('SwitcherApp rendered');
});
