import { VSWindow as VSWindowModel } from '@prisma/client';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import Highlighter from 'react-highlight-words';
import Select, { components, OptionProps } from 'react-select';
import { HoverButton } from './HoverButton';
import PopupDefaultExample from './popup';
import TerminalTab from './terminal-tab';

type SwitcherMode = 'projects' | 'sessions' | 'terminal';
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

  @keyframes statusPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  @keyframes statusBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.2; }
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
  window.electronAPI.invokeVSCode(`${path}`, option);
}

function hideApp() {
  window.electronAPI.hideApp();
}

function searchWorkingFolder(path: string) {
  window.electronAPI.searchWorkingFolder(path);
}

export function openFolderSelector() {
  window.electronAPI.openFolderSelector();
}

export function closeAppClick() {
  window.electronAPI.closeAppClick();
}

export function fetchVSCodeBasedIDESqlite() {
  window.electronAPI.fetchVSCodeBasedIDESqlite();
}
export function deleteVSCodeBasedIDESqliteRecord(path: string) {
  console.log('ui deleteVSCodeBasedIDESqliteRecord:');

  window.electronAPI.deleteVSCodeBasedIDESqliteRecord(path);
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
        padding: '6px 10px',
        margin: '1px 0',
        borderRadius: '3px',
        borderLeft: isFocused
          ? `3px solid ${THEME.primary}`
          : '3px solid transparent',
        backgroundColor: isFocused
          ? 'rgba(0, 188, 212, 0.08)'
          : 'transparent',
        transition: 'background-color 0.15s',
        cursor: 'pointer',
        height: '34px', // Match item height
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
  const ignoreMouseEnterRef = useRef(false);
  const forceFocusOnInput = () => {
    if (modeRef.current === 'terminal') return; // terminal handles its own focus
    if (modeRef.current === 'sessions') {
      sessionSearchRef.current?.focus();
    } else {
      ref.current?.focus();
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
  const [projectBranches, setProjectBranches] = useState<Record<string, string>>({});
  const [activeIDEFolders, setActiveIDEFolders] = useState<Set<string>>(new Set());
  const [allSessions, setAllSessions] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(-1);
  const [sessionDisplayMode, setSessionDisplayMode] = useState('first');
  const [customTitles, setCustomTitles] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [prLinks, setPrLinks] = useState<Record<string, { prNumber: number; prUrl: string }>>({});
  const [assistantResponses, setAssistantResponses] = useState<Record<string, string>>({});
  const [terminalApps, setTerminalApps] = useState<Record<string, string>>({});
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});
  const modeRef = useRef<SwitcherMode>('projects');
  const activeStateRef = useRef<Record<string, number>>({});

  const updateWorkingPathUIAndList = async (path: string) => {
    setWorkingFolderPath(path);

    if (path) {
      searchWorkingFolder(path);
    }
  };

  const fetchRecentProjectRecord = async () => {
    fetchVSCodeBasedIDESqlite(); //retryFetchRecentProjectRecord();
  };

  const filterSessionsLocally = (allItems: any[], query: string) => {
    if (!query.trim()) return allItems;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return allItems.filter((s) => {
      const prInfo = prLinks[s.sessionId];
      const searchTarget = `${s.projectName} ${s.project} ${s.firstUserMessage} ${s.lastUserMessage} ${customTitles[s.sessionId] || ''} ${branches[s.sessionId] || ''} ${prInfo ? `PR #${prInfo.prNumber} ${prInfo.prUrl}` : ''} ${assistantResponses[s.sessionId] || ''}`.toLowerCase();
      return words.every((w: string) => searchTarget.includes(w));
    });
  };

  const fetchClaudeSessions = async () => {
    // Step 1: Show sessions immediately, preserve old active states (SWR via ref)
    const result = await window.electronAPI.getClaudeSessions(100);
    const cachedActive = activeStateRef.current;
    const newSessions = (result || []).map((s: any) => {
      if (s.sessionId in cachedActive) {
        return { ...s, isActive: true, activePid: cachedActive[s.sessionId] };
      }
      return s;
    });
    setAllSessions(newSessions);
    setSessions(sessionSearchValue.trim() ? filterSessionsLocally(newSessions, sessionSearchValue) : newSessions);

    // Step 2: Load last assistant responses for all sessions (first 100)
    window.electronAPI.loadLastAssistantResponses((result || []).slice(0, 100)).then((responses: Record<string, string>) => {
      if (responses && Object.keys(responses).length > 0) {
        setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
      }
    });

    // Step 3: Detect active sessions in background (slow, spawns processes)
    window.electronAPI.detectActiveSessions().then((activeMap: Record<string, number>) => {
      // Save to ref for SWR on next refresh
      activeStateRef.current = activeMap || {};

      const updateActive = (list: any[]) => list.map((s) => ({
        ...s,
        isActive: s.sessionId in (activeMap || {}),
        activePid: (activeMap || {})[s.sessionId],
      }));
      setAllSessions((prev: any[]) => updateActive(prev));
      setSessions((prev: any[]) => updateActive(prev));

      if (activeMap && Object.keys(activeMap).length > 0) {

        // Step 2c: Detect terminal apps for active sessions
        if (Object.keys(activeMap).length > 0) {
          window.electronAPI.detectTerminalApps(activeMap).then((apps: Record<string, string>) => {
            if (apps && Object.keys(apps).length > 0) {
              setTerminalApps((prev: Record<string, string>) => ({ ...prev, ...apps }));
            }
          });
        }
      }
    });

    // Step 3: Load custom titles + branches in background
    if (result && result.length > 0) {
      window.electronAPI.loadSessionEnrichment(result.slice(0, 100)).then((enrichment) => {
        if (enrichment.titles && Object.keys(enrichment.titles).length > 0) {
          setCustomTitles((prev: Record<string, string>) => ({ ...prev, ...enrichment.titles }));
        }
        if (enrichment.branches && Object.keys(enrichment.branches).length > 0) {
          setBranches((prev: Record<string, string>) => ({ ...prev, ...enrichment.branches }));
        }
        if (enrichment.prLinks && Object.keys(enrichment.prLinks).length > 0) {
          setPrLinks((prev) => ({ ...prev, ...enrichment.prLinks }));
        }
      });
    }
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
      // Tab (without modifiers) to toggle between Projects and Sessions
      // - Switching to sessions: refetch sessions (projects rely on window-focus refresh)
      // - Switching to projects: no refetch (projects already refreshed on window focus)
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && modeRef.current !== 'terminal') {
        e.preventDefault();
        const newMode = modeRef.current === 'projects' ? 'sessions' : 'projects';
        modeRef.current = newMode;
        setMode(newMode);
        if (newMode === 'sessions') {
          fetchClaudeSessions();
        }
      }
      // Ctrl+Tab or Cmd+] to cycle forward, Cmd+[ to cycle backward
      const isCycleForward = (e.ctrlKey && !e.metaKey && e.key === 'Tab') || (e.metaKey && !e.ctrlKey && e.key === ']');
      const isCycleBackward = e.metaKey && !e.ctrlKey && e.key === '[';
      if (isCycleForward || isCycleBackward) {
        e.preventDefault();
        const cycle: SwitcherMode[] = ['projects', 'sessions', 'terminal'];
        const idx = cycle.indexOf(modeRef.current);
        const newMode = cycle[(idx + (isCycleForward ? 1 : cycle.length - 1)) % cycle.length];
        modeRef.current = newMode;
        setMode(newMode);
        if (newMode === 'sessions') fetchClaudeSessions();
      }
      // Cmd+1/2/3 to jump to specific tab
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        const tabMap: Record<string, SwitcherMode> = { '1': 'projects', '2': 'sessions', '3': 'terminal' };
        if (tabMap[e.key]) {
          e.preventDefault();
          const newMode = tabMap[e.key];
          modeRef.current = newMode;
          setMode(newMode);
          if (newMode === 'sessions') fetchClaudeSessions();
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
      // Don't steal focus from Settings panel interactions (dropdowns, buttons, etc.)
      const target = e.target as HTMLElement;
      if (target.closest('[data-settings-panel]')) return;
      forceFocusOnInput();
    });

    window.electronAPI.onSwitchToTerminal(() => {
      modeRef.current = 'terminal';
      setMode('terminal');
    });

    // Session status updates from hooks (fs.watch)
    window.electronAPI.getSessionStatuses().then((statuses: Record<string, string>) => {
      if (statuses) setSessionStatuses(statuses);
    });
    window.electronAPI.onSessionStatusesUpdated((_event: any, statuses: Record<string, string>) => {
      // Use disk snapshot as source of truth — clears removed sessions
      setSessionStatuses(statuses);
    });

    window.electronAPI.onCheckTerminalAndHide(() => {
      if (modeRef.current === 'terminal') {
        window.electronAPI.hideApp();
      } else {
        modeRef.current = 'terminal';
        setMode('terminal');
      }
    });

    // Data refresh on window focus:
    // - Projects: always refetch (complements tab-switch which doesn't refetch projects)
    // - Sessions: only refetch if sessions tab is active (tab-switch already fetches on entry)
    window.electronAPI.onFocusWindow((_event: any) => {
      if (modeRef.current !== 'terminal') {
        fetchRecentProjectRecord();
        fetchWorkingFolderAndUpdate();
        window.electronAPI.detectActiveIDEProjects().then((folders: string[]) => {
          setActiveIDEFolders(new Set(folders));
        });
      }
      if (modeRef.current === 'sessions') {
        fetchClaudeSessions();
      }
      // Refresh session statuses on window focus
      window.electronAPI.getSessionStatuses().then((statuses: Record<string, string | null>) => {
        if (statuses) setSessionStatuses(statuses);
      });
      // Refresh display mode setting
      window.electronAPI.getSessionDisplayMode().then((mode: string) => {
        setSessionDisplayMode(mode || 'first');
      });
      // Ignore mouse hover briefly to prevent selected item jumping to mouse position
      ignoreMouseEnterRef.current = true;
      setTimeout(() => { ignoreMouseEnterRef.current = false; }, 300);
      // Re-focus search input so arrow keys work (not captured by scroll container)
      setTimeout(() => {
        if (modeRef.current === 'terminal') return;
        if (modeRef.current === 'sessions') {
          sessionSearchRef.current?.focus();
        } else {
          ref.current?.focus();
        }
      }, 50);
    });

    window.electronAPI.onWorkingFolderIterated(
      async (_event: any, paths: string[]) => {
        setWorkingPathInfoArray(paths);
      },
    );

    window.electronAPI.onXWinNotFound((_event: any) => {
      /** currently the popup message is done by electron native UI */
    });

    window.electronAPI.onFolderSelected(
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
          window.electronAPI.popupAlert('failed to save');
        }
      },
    );

    window.electronAPI.onVSCodeBasedSqliteRead(
      async (_event: any, recentProject: VSWindowModel[]) => {
        setPathInfoArray(recentProject);
        // Load git branches in background (SWR pattern - don't block rendering)
        const paths = recentProject.map((p) => p.path);
        if (paths.length > 0) {
          window.electronAPI.loadProjectBranches(paths).then((branches: Record<string, string>) => {
            if (branches && Object.keys(branches).length > 0) {
              setProjectBranches(branches);
            }
          });
          window.electronAPI.detectActiveIDEProjects().then((folders: string[]) => {
            setActiveIDEFolders(new Set(folders));
          });
        }
      },
    );
    window.electronAPI.onVSCodeBasedSqliteRecordDeleted(
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

    // Load default switcher mode
    window.electronAPI.getDefaultSwitcherMode().then((defaultMode: string) => {
      if (defaultMode === 'sessions') {
        modeRef.current = 'sessions';
        setMode('sessions');
        fetchClaudeSessions();
      } else if (defaultMode === 'terminal') {
        modeRef.current = 'terminal';
        setMode('terminal');
      }
    });

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
      const branch = projectBranches[candidate?.value] || '';
      target = (candidate?.value + ' ' + branch).toLowerCase();
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
            {mode === 'sessions' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ verticalAlign: 'middle' }}>
                {/* Anthropic-style starburst — organic, varied ray lengths */}
                {[
                  { angle: 0, len: 10 }, { angle: 30, len: 5.5 }, { angle: 55, len: 7 },
                  { angle: 90, len: 9.5 }, { angle: 125, len: 6 }, { angle: 155, len: 8 },
                  { angle: 180, len: 10 }, { angle: 210, len: 5 }, { angle: 240, len: 7.5 },
                  { angle: 270, len: 9 }, { angle: 305, len: 6.5 }, { angle: 335, len: 7 },
                ].map(({ angle, len }) => {
                  const rad = (angle * Math.PI) / 180;
                  return (
                    <line
                      key={angle}
                      x1="12" y1="12"
                      x2={12 + Math.cos(rad) * len}
                      y2={12 + Math.sin(rad) * len}
                      stroke="#E8B830"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  );
                })}
              </svg>
            ) : mode === 'terminal' ? '💻' : '📂'}
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
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: mode === 'projects' ? THEME.primary : 'transparent',
                color: mode === 'projects' ? '#fff' : THEME.text.secondary,
                transition: 'background-color 0.2s',
                WebkitAppearance: 'none',
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
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: mode === 'sessions' ? THEME.primary : 'transparent',
                color: mode === 'sessions' ? '#fff' : THEME.text.secondary,
                transition: 'background-color 0.2s',
                WebkitAppearance: 'none',
              }}
            >
              Sessions
            </button>
            <button
              onClick={() => { modeRef.current = 'terminal'; setMode('terminal'); }}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                border: 'none',
                outline: 'none',
                cursor: 'pointer',
                backgroundColor: mode === 'terminal' ? THEME.primary : 'transparent',
                color: mode === 'terminal' ? '#fff' : THEME.text.secondary,
                transition: 'background-color 0.2s',
                WebkitAppearance: 'none',
              }}
            >
              Term
            </button>
          </div>
          <PopupDefaultExample
            workingFolderPath={workingFolderPath}
            switcherMode={mode}
            saveCallback={(key: string, value: string) => {
              if (key === 'sessionDisplayMode') {
                setSessionDisplayMode(value);
              }
            }}
          />
        </div>
      </div>

      {/* Terminal tab: always mounted, toggle visibility to preserve state */}
      <div style={{ flex: 1, overflow: 'hidden', display: mode === 'terminal' ? 'flex' : 'none' }}>
        <TerminalTab visible={mode === 'terminal'} />
      </div>

      {mode !== 'terminal' && (mode === 'sessions' ? (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 15px 0' }}>
            <input
              ref={sessionSearchRef}
              value={sessionSearchValue}
            onChange={(e) => {
              const val = e.target.value;
              setSessionSearchValue(val);
              setSessions(filterSessionsLocally(allSessions, val));
              setSelectedSessionIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (sessionSearchValue) {
                  setSessionSearchValue('');
                  setSessions(allSessions);
                } else {
                  hideApp();
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSessionIndex((i) => {
                  const next = Math.min(i + 1, sessions.length - 1);
                  setTimeout(() => document.querySelector(`[data-session-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
                  return next;
                });
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSessionIndex((i) => {
                  const next = i <= 0 ? -1 : i - 1;
                  if (next >= 0) {
                    setTimeout(() => document.querySelector(`[data-session-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
                  }
                  return next;
                });
              } else if (e.key === 'PageDown') {
                e.preventDefault();
                setSelectedSessionIndex((i) => {
                  const next = Math.min(i + 5, sessions.length - 1);
                  setTimeout(() => document.querySelector(`[data-session-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
                  return next;
                });
              } else if (e.key === 'PageUp') {
                e.preventDefault();
                setSelectedSessionIndex((i) => {
                  const next = Math.max(i - 5, 0);
                  setTimeout(() => document.querySelector(`[data-session-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
                  return next;
                });
              } else if (e.key === 'Enter') {
                const idx = selectedSessionIndex >= 0 ? selectedSessionIndex : 0;
                const s = sessions[idx];
                if (s) {
                  window.electronAPI.openClaudeSession(s.sessionId, s.project, s.isActive, s.activePid, customTitles[s.sessionId]);
                }
              }
            }}
              placeholder="Search sessions..."
              autoFocus
              style={{
                backgroundColor: '#2d2d2d',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '10px 12px',
                flex: 1,
                color: THEME.text.primary,
                fontSize: '14px',
                outline: 'none',
              }}
            />
            <span style={{ color: THEME.text.secondary, fontSize: '12px', whiteSpace: 'nowrap' }}>
              {sessions.length} sessions
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 8px' }}>
            {sessions.length === 0 ? (
              <div style={{ color: THEME.text.secondary, textAlign: 'center', padding: '20px 0' }}>
                {sessionSearchValue ? '⚠️ No matching sessions found' : '🤖 No Claude Code sessions found'}
              </div>
            ) : (
              sessions.map((session, index) => (
                <div
                  key={session.sessionId}
                  data-session-index={index}
                  onClick={() => {
                    window.electronAPI.openClaudeSession(session.sessionId, session.project, session.isActive, session.activePid, customTitles[session.sessionId]);
                  }}
                  style={{
                    display: 'flex',
                    padding: '6px 10px',
                    margin: '1px 0',
                    borderRadius: '3px',
                    backgroundColor: 'transparent',
                    borderLeft: index === selectedSessionIndex ? `3px solid ${THEME.primary}` : '3px solid transparent',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                  }}
                  onMouseEnter={() => { if (!ignoreMouseEnterRef.current) setSelectedSessionIndex(index); }}
                >
                  {/* Fixed-width dot container for alignment */}
                  <div style={{ width: '14px', flexShrink: 0, paddingTop: '4px' }}>
                    {session.isActive && (() => {
                      const status = sessionStatuses[session.sessionId];
                      const color = status === 'working' ? '#E8956A'
                        : status === 'idle' ? '#66BB6A'
                        : status === 'needs-attention' ? '#FFA726'
                        : '#CE93D8'; // no status data yet
                      const animation = status === 'working' ? 'statusPulse 2s ease-in-out infinite'
                        : status === 'needs-attention' ? 'statusBlink 1s ease-in-out infinite'
                        : 'none';
                      return <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        backgroundColor: color, display: 'inline-block',
                        animation,
                      }} />;
                    })()}
                  </div>
                  {/* Content area */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Line 1: project name + custom title + metadata */}
                    <div style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                        {customTitles[session.sessionId] && (
                          <span style={{ color: '#7ec87e', fontSize: '13px', fontWeight: '500' }}>
                            {' '}· <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              textToHighlight={customTitles[session.sessionId].slice(0, 35)}
                              highlightStyle={{
                                backgroundColor: 'rgba(126, 200, 126, 0.2)',
                                color: '#a0e8a0',
                                padding: '0 2px',
                                borderRadius: '2px',
                              }}
                            />
                          </span>
                        )}
                        {branches[session.sessionId] && (
                          <span style={{ color: '#888', fontSize: '11px', fontStyle: 'italic' }}>
                            {' '}[<Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              textToHighlight={branches[session.sessionId]}
                              highlightStyle={{
                                backgroundColor: 'rgba(200, 200, 200, 0.15)',
                                color: '#bbb',
                                padding: '0 2px',
                                borderRadius: '2px',
                              }}
                            />]
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, marginLeft: '10px' }}>
                        {session.isActive && terminalApps[session.sessionId] && terminalApps[session.sessionId] !== 'unknown' && (
                          <span style={{
                            fontSize: '9px',
                            color: '#aaa',
                            border: '1px solid #555',
                            borderRadius: '3px',
                            padding: '1px 4px',
                            textTransform: 'uppercase',
                          }}>
                            {terminalApps[session.sessionId]}
                          </span>
                        )}
                        {prLinks[session.sessionId] && (
                          <span
                            style={{
                              fontSize: '10px',
                              color: '#7ec8e3',
                              border: '1px solid #4a8a9e',
                              borderRadius: '3px',
                              padding: '1px 5px',
                              cursor: 'pointer',
                            }}
                            title={prLinks[session.sessionId].prUrl}
                            onClick={(e) => {
                              e.stopPropagation();
                              window.electronAPI.openExternal(prLinks[session.sessionId].prUrl);
                            }}
                          >
                            PR #{prLinks[session.sessionId].prNumber}
                          </span>
                        )}
                        <span style={{ color: THEME.text.secondary, fontSize: '12px' }}>
                          {session.messageCount} msgs
                        </span>
                        <span style={{ color: THEME.text.secondary, fontSize: '12px', minWidth: '50px', textAlign: 'right' }}>
                          {formatRelativeTime(session.lastTimestamp)}
                        </span>
                      </div>
                    </div>
                    {/* Line 2: first/last prompt (smaller text, only if content exists) */}
                    {(session.firstUserMessage || session.lastUserMessage) && (
                      <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '2px' }}>
                        {(sessionDisplayMode === 'first' || sessionDisplayMode === 'both') && session.firstUserMessage && (
                          <span style={{ color: '#999', fontSize: '12px' }}>
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              textToHighlight={(session.firstUserMessage || '').slice(0, sessionDisplayMode === 'both' ? 50 : 80)}
                              highlightStyle={{
                                backgroundColor: 'rgba(0, 188, 212, 0.1)',
                                color: '#bbb',
                                padding: '0 2px',
                                borderRadius: '2px',
                              }}
                            />
                          </span>
                        )}
                        {sessionDisplayMode === 'last' && session.lastUserMessage && (
                          <span style={{ color: '#c89030', fontSize: '12px' }}>
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              textToHighlight={(session.lastUserMessage || '').slice(0, 80)}
                              highlightStyle={{
                                backgroundColor: 'rgba(232, 169, 70, 0.15)',
                                color: '#e8a946',
                                padding: '0 2px',
                                borderRadius: '2px',
                              }}
                            />
                          </span>
                        )}
                        {sessionDisplayMode === 'both' && session.lastUserMessage && session.lastUserMessage !== session.firstUserMessage && (
                          <span style={{ color: '#c89030', fontSize: '12px' }}>
                            {'  →  '}
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              textToHighlight={(session.lastUserMessage || '').slice(0, 40)}
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
                    )}
                    {/* Line 3: Last assistant response */}
                    {assistantResponses[session.sessionId] && (
                      <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '1px' }}>
                        <span style={{ color: '#9DC8E0', fontSize: '11px' }}>
                          ◀ <Highlighter
                            searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                            textToHighlight={assistantResponses[session.sessionId].slice(0, 80)}
                            highlightStyle={{
                              backgroundColor: 'rgba(139, 184, 208, 0.15)',
                              color: '#A8CDE0',
                              padding: '0 2px',
                              borderRadius: '2px',
                            }}
                          />
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
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
        formatOptionLabel={(
          { value, label, everOpened }: { value: string; label: string; everOpened: boolean },
          { inputValue: searchInput }: { inputValue: string },
        ) => {
          const searchWords = (searchInput ?? '')
            .split(' ')
            .filter((sub: string) => sub);
          const pathPart = label?.slice(0, label.lastIndexOf('/'));
          let name = label?.slice(label.lastIndexOf('/') + 1);
          name = name?.replace(/\.code-workspace/, ' (Workspace)');
          const branch = projectBranches[value];
          const folderName = value?.split('/').pop() || '';
          const isActiveInIDE = activeIDEFolders.has(folderName);

          const nameStyle: any = {
            fontWeight: '500',
            fontSize: '15px',
            paddingRight: '6px',
            flexShrink: 0,
            color: everOpened ? THEME.text.primary : THEME.text.newItem,
          };

          return (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '2px 0',
                width: '100%',
                height: '30px',
              }}
            >
              <div style={{ width: '14px', marginRight: '4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isActiveInIDE && (
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#CE93D8', display: 'inline-block' }} />
                )}
              </div>
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
              {branch && (
                <span style={{ color: '#888', fontSize: '13px', fontStyle: 'italic', flexShrink: 0, paddingRight: '10px' }}>
                  [<Highlighter
                    searchWords={searchWords}
                    textToHighlight={branch}
                    highlightStyle={{
                      backgroundColor: 'rgba(200, 200, 200, 0.15)',
                      color: '#bbb',
                      padding: '0 2px',
                      borderRadius: '2px',
                    }}
                  />]
                </span>
              )}
              <div style={{
                fontSize: '13px',
                color: THEME.text.secondary,
                flex: 1,
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textAlign: 'right',
              }}>
                <Highlighter
                  searchWords={searchWords}
                  textToHighlight={pathPart}
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
        }}
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
      </div>
      ))}
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
