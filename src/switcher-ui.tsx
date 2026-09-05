import { VSWindow as VSWindowModel } from '@prisma/client';
import { FC, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import Highlighter from 'react-highlight-words';
import Select, { components, OptionProps } from 'react-select';
import { HoverButton } from './HoverButton';
import PopupDefaultExample from './popup';
import type { LiveRowInfo } from './session-list-view';
import type { SessionList, SessionListMember } from './session-lists';
import {
  buildSessionListView,
  ListViewSession,
  mergeSessionsById,
} from './session-list-view';
import {
  matchesAllWordsOrId,
  matchesSessionId,
  truncateMiddle,
  windowAroundMatch,
} from './session-search';
import TerminalTab from './terminal-tab';

type LiveReport = Awaited<ReturnType<Window['electronAPI']['getLiveSessions']>>;
type ListsResponse = Awaited<ReturnType<Window['electronAPI']['getSessionLists']>>;
/** Shape every list mutation returns (save / delete / rename). */
type ListsWriteResult = {
  ok: boolean;
  error?: string;
  lists?: { lists: SessionList[] };
};

type SwitcherMode = 'projects' | 'sessions' | 'terminal';
// import { fetchVSCodeBasedOpenedWindows, SERVER_URL, deleteRecentProjectRecord } from "./vscode-based-ide-utility"
export const SERVER_URL = 'http://localhost:55688';

// The matched-prompt line answers "why is this row here". It used to be #999
// with a U+2315 marker unreadable at 11px (reported as "•" and then "ρ" by the
// person who asked for the feature), so it read as a second copy of the
// first-message line — issue #138. The identity now lives in the chip below
// rather than in the line's colour: an amber line body sat too close to the
// orange last-message line, and the snippet IS a user prompt, so the neutral
// prompt grey is also the honest colour for its text.
const SNIPPET_LINE_STYLE = { color: '#999', fontSize: '11px' } as const;

// Unified search-match highlight — high contrast on every row color scheme
// (the previous per-site translucent styles were near-invisible on colored text).
const SEARCH_HIGHLIGHT_STYLE = {
  backgroundColor: '#f5b942',
  color: '#1a1a1a',
  padding: '0 2px',
  borderRadius: '2px',
  fontWeight: 600,
} as const;

// Deliberately the SAME amber as SEARCH_HIGHLIGHT_STYLE: the chip and the
// highlighted words are one system, so the row reads as "search found this
// here" at a glance. The line's text stays the neutral prompt grey — an amber
// line body sat too close to the orange last-message line, and the snippet IS
// a user prompt, so colouring it as one is also the honest choice.
const SNIPPET_MARKER_STYLE = {
  color: SEARCH_HIGHLIGHT_STYLE.color,
  backgroundColor: SEARCH_HIGHLIGHT_STYLE.backgroundColor,
  borderRadius: '2px',
  padding: '0 4px',
  fontSize: '10px',
  fontWeight: 600,
} as const;

// Boundary header of the expanded minor-sessions group. Sticky: it pins to
// the top while scrolled inside the minors zone, so collapsing never
// requires scrolling back to the boundary row.
const MINOR_FOLD_HEADER_STYLE = {
  padding: '6px 10px 4px 24px',
  color: '#777',
  fontSize: '12px',
  cursor: 'pointer',
  position: 'sticky',
  top: 0,
  zIndex: 1,
  backgroundColor: '#1a1a1a',
} as const;

// Always-visible fold bar below the scroll area while minors are expanded.
const MINOR_FOLD_BAR_STYLE = {
  padding: '6px 15px 8px',
  color: '#888',
  fontSize: '12px',
  cursor: 'pointer',
  borderTop: '1px solid #2e2e2e',
  flexShrink: 0,
} as const;

// Referenced by style constants declared above THEME (which is defined later
// in this file); the value is THEME.text.primary.
const THEME_TEXT_PRIMARY = '#E9E9E9';

// Header row of the pinned zone at the top of the Sessions list. It carries
// two independent toggles on one line — the label groups/ungroups the zone,
// the "only" chip scopes browsing and search to pins — so neither costs
// vertical space, which is the scarce resource in a menu-bar popup.
const PINNED_HEADER_STYLE = {
  padding: '6px 10px 2px 24px',
  color: '#c9a227',
  fontSize: '12px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
} as const;

const PINNED_ONLY_CHIP_STYLE = {
  fontSize: '10px',
  borderRadius: '3px',
  padding: '1px 6px',
  cursor: 'pointer',
  border: '1px solid #6b5a1e',
  color: '#c9a227',
  backgroundColor: 'transparent',
} as const;

const PINNED_ONLY_CHIP_ACTIVE_STYLE = {
  ...PINNED_ONLY_CHIP_STYLE,
  border: '1px solid #c9a227',
  color: '#1e1e1e',
  backgroundColor: '#c9a227',
} as const;

// Scope chips in the search row (issues #94 / #145). They sit beside the
// session count because that row has spare width and the list has none —
// every scope is one click away without costing a line.
const SCOPE_CHIP_STYLE = {
  fontSize: '10px',
  borderRadius: '3px',
  padding: '1px 6px',
  cursor: 'pointer',
  border: '1px solid #3f5f4a',
  color: '#7ec87e',
  backgroundColor: 'transparent',
  whiteSpace: 'nowrap',
} as const;

const SCOPE_CHIP_ACTIVE_STYLE = {
  ...SCOPE_CHIP_STYLE,
  border: '1px solid #7ec87e',
  color: '#1e1e1e',
  backgroundColor: '#7ec87e',
} as const;

const LISTS_CHIP_STYLE = {
  ...SCOPE_CHIP_STYLE,
  border: '1px solid #4a6a8a',
  color: '#9DC8E0',
} as const;

const LISTS_CHIP_ACTIVE_STYLE = {
  ...LISTS_CHIP_STYLE,
  border: '1px solid #9DC8E0',
  color: '#1e1e1e',
  backgroundColor: '#9DC8E0',
} as const;

// Header of the saved-lists zone and of a list being viewed. Same geometry as
// the pinned header so the two zones read as siblings.
const LISTS_HEADER_STYLE = {
  ...PINNED_HEADER_STYLE,
  color: '#9DC8E0',
} as const;

const LIST_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 10px 4px 24px',
  margin: '1px 0',
  borderRadius: '3px',
  cursor: 'pointer',
  fontSize: '12px',
  color: THEME_TEXT_PRIMARY,
} as const;

// Per-row process facts in the live scope: memory, uptime, terminal. Muted —
// the row is still a session row first.
const LIVE_INFO_STYLE = {
  fontSize: '10px',
  color: '#8fbc8f',
  border: '1px solid #3f5f4a',
  borderRadius: '3px',
  padding: '1px 5px',
  whiteSpace: 'nowrap',
} as const;

const LIVE_WARN_STYLE = {
  ...LIVE_INFO_STYLE,
  color: '#e0b060',
  border: '1px solid #8a6a2a',
} as const;

// The recap line on a saved-list member. Its own marker, its own colour
// family (the list blue), so it is never mistaken for the amber search
// snippet or the grey message lines.
const RECAP_MARKER_STYLE = {
  color: '#1e1e1e',
  backgroundColor: '#9DC8E0',
  borderRadius: '2px',
  padding: '0 4px',
  fontSize: '10px',
  fontWeight: 600,
} as const;

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

  /* The whole saved-list row is the click target; say so on hover. */
  .codev-list-row:hover {
    background-color: #2a2a2a;
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
/** Convert Electron accelerator to macOS symbol string (e.g. "Command+Control+R" → "⌃⌘R") */
const acceleratorToSymbols = (acc: string): string =>
  acc
    .replace(/Command/g, '⌘')
    .replace(/Control/g, '⌃')
    .replace(/Alt/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '');

let _homeDir = '';
let _homePrefix = '';
// Fetch home dir async on load, cache for sync access
window.electronAPI?.getHomeDir?.().then((dir: string) => {
  _homeDir = dir || '';
  _homePrefix = _homeDir ? _homeDir + '/' : '';
});
const getHomeDir = (): string => _homeDir;

/** Replace /Users/<user>/ with ~/ for display */
const shortenPath = (p: string): string => {
  const home = getHomeDir();
  if (!home) return p;
  if (p === home) return '~';
  const prefix = _homePrefix;
  return p?.startsWith(prefix) ? '~/' + p.slice(prefix.length) : p;
};

// Note: the unused formatOptionLabel was removed — the inline version
// in the Select component (with branch display + IDE dot) is the one used.

export interface SelectInputOptionInterface {
  readonly value: string;
  readonly label: string;
  isDisabled: boolean;
  isSelected: boolean;
}

// Enhanced Option component with improved styling and hover effects
const OptionUI = (
  props: OptionProps<SelectInputOptionInterface>,
  onDeleteClick?: (data: any) => void,
  onCmdClick?: (path: string) => void,
) => {
  const { selectOption, selectProps, data, isSelected, isFocused } = props;
  const { value, label } = data;

  return (
    <div
      key={value}
      onClickCapture={(e) => {
        if (e.metaKey && onCmdClick) {
          e.stopPropagation();
          e.preventDefault();
          onCmdClick(value);
        }
      }}
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
// Sessions carry epoch-ms numbers; the old `string` annotation only survived
// because every caller went through an `any` row. `new Date()` takes both.
const formatRelativeTime = (timestamp: number | string): string => {
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

/** `17d` / `2d13h` / `3h05m` / `12m` — how long a process has been up. */
const formatUptime = (sec: number): string => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d >= 3) return `${d}d`;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
};

const formatMb = (kb: number): string => {
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
};

/**
 * Default name for a saved list: today's `MMDD`, the way the user names
 * them, and `MMDD-2`, `MMDD-3`… once that is taken. A name is a label, not
 * an identity (lists are keyed by a generated id), so duplicates are legal —
 * they are just not what a second save in one day usually means.
 */
const nextListName = (existing: string[]): string => {
  const d = new Date();
  const base = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
};

/** Caution it will be invoked twice due to <React.StrictMode> !! */
let loadTimes = 0;
function SwitcherApp() {
  const optionPress = useRef(false);
  const launchClaudeRef = useRef<'external' | 'codev' | 'external-pick' | null>(null);

  // 2c-lite: ⌥⌘+Enter — pick the account for a new-session launch.
  type LaunchAccount = {
    label: string;
    email?: string;
    loggedIn?: boolean;
    isCurrentDefault: boolean;
  };
  const [launchPicker, setLaunchPicker] = useState<{
    path: string;
    accounts: LaunchAccount[];
  } | null>(null);
  const [launchPickerIndex, setLaunchPickerIndex] = useState(0);
  // Multi-account? → advertise ⌥⌘+Enter in the search-bar hint (single-account
  // users see the unchanged short hint — no extra clutter).
  const [isMultiAccountUI, setIsMultiAccountUI] = useState(false);

  const openAccountPickerForLaunch = async (projectPath: string) => {
    try {
      const r = await window.electronAPI.getAccounts();
      if (!r.ok) {
        // The user explicitly asked to pick — don't guess an identity when
        // the account list can't be loaded.
        console.error('[account-picker] failed to load accounts:', r.error);
        return;
      }
      const accounts = (r.accounts || []) as LaunchAccount[];
      if (accounts.length <= 1) {
        // Single account (or no registry): nothing to pick — launch as usual.
        window.electronAPI.launchNewClaudeSession(projectPath);
        return;
      }
      setLaunchPickerIndex(0);
      setLaunchPicker({ path: projectPath, accounts });
    } catch (e) {
      console.error('[account-picker] failed to load accounts:', e);
    }
  };

  const pickLaunchAccount = (account: LaunchAccount) => {
    if (!launchPicker) return;
    window.electronAPI.launchNewClaudeSession(launchPicker.path, account.label);
    setLaunchPicker(null);
  };

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

  // Read initial mode from URL hash (set by main process) to avoid flash
  const initialMode = (() => {
    const hash = window.location.hash; // e.g. #mode=sessions
    const match = hash.match(/mode=(\w+)/);
    const m = match?.[1];
    return (m === 'sessions' || m === 'terminal') ? m : 'projects';
  })();
  const [mode, setMode] = useState<SwitcherMode>(initialMode);
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
  const [allSessions, setAllSessions] = useState<ListViewSession[]>([]);
  const [sessions, setSessions] = useState<ListViewSession[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(-1);
  const [sessionDisplayMode, setSessionDisplayMode] = useState('first');
  const [customTitles, setCustomTitles] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [prLinks, setPrLinks] = useState<Record<string, { prNumber: number; prUrl: string }>>({});
  const [assistantResponses, setAssistantResponses] = useState<Record<string, string>>({});
  const [terminalApps, setTerminalApps] = useState<Record<string, string>>({});
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});
  const [searchSnippets, setSearchSnippets] = useState<Record<string, { snippet: string; promptIndex: number; isLastPrompt: boolean }>>({});
  const [minorsExpanded, setMinorsExpanded] = useState(false);
  // Folding waits for the first active-session detection so a just-started
  // (≤2 msgs, not-yet-detected) session is never folded away at app start.
  const [activeDetectionReady, setActiveDetectionReady] = useState(false);
  // Pin/hide marks (PR-2), pushed from main via fs.watch on session-marks.json
  const [sessionMarks, setSessionMarks] = useState<{
    pins: Record<string, { pinnedAt: string; cwd: string; accountLabel?: string }>;
    hidden: string[];
  }>({ pins: {}, hidden: [] });
  // False until the first getSessionMarks() response lands. Before that an
  // empty pin set means "not known yet", not "no pins".
  const [marksLoaded, setMarksLoaded] = useState(false);
  // Set by the first fs.watch push; makes the initial read's response stale.
  const marksPushSeenRef = useRef(false);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('codev-pinned-collapsed') === '1';
    } catch {
      return false;
    }
  });
  // Browse/search SCOPE: while on, only pinned sessions are listed and the
  // search box searches inside them. Independent of the collapse toggle, which
  // only decides whether pins are grouped at the top or left in time order.
  const [pinnedOnly, setPinnedOnly] = useState(() => {
    try {
      return localStorage.getItem('codev-pinned-only') === '1';
    } catch {
      return false;
    }
  });
  // Pinned sessions living outside the loaded list (fetched by id)
  const [extraPinnedSessions, setExtraPinnedSessions] = useState<
    ListViewSession[]
  >([]);
  // Mirrored into a ref: applySearchFilter runs from a debounced timeout and
  // from setState updaters, where reading React state gives the value captured
  // when the callback was created (the stale-closure trap this file has been
  // bitten by twice — see sessionSearchRef2).
  const extraPinnedSessionsRef = useRef<ListViewSession[]>([]);
  const extraPinnedKeyRef = useRef('');
  // The transcript's recap line per session (enrichment), captured into lists.
  const [recaps, setRecaps] = useState<Record<string, { text: string; at: string }>>({});
  // Live scope (issue #94): only running sessions, with process facts. Not
  // persisted — it describes this moment, not a preference.
  const [liveOnly, setLiveOnly] = useState(false);
  const liveOnlyRef = useRef(false);
  // Per-row process figures inside the live scope. Off by default: memory
  // and uptime track message count closely enough that on most rows they
  // are noise (user verdict, second live test); the one number that says
  // whether there is a problem is the total beside the search box, which
  // stays. Persisted — a preference, not a moment.
  const [liveStats, setLiveStats] = useState(() => {
    try {
      return localStorage.getItem('codev-live-stats') === '1';
    } catch {
      return false;
    }
  });
  const [liveReport, setLiveReport] = useState<LiveReport | null>(null);
  // Saved session lists (issue #145), pushed from main via fs.watch.
  const [sessionLists, setSessionLists] = useState<SessionList[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const listsPushSeenRef = useRef(false);
  const [listsExpanded, setListsExpanded] = useState(() => {
    try {
      return localStorage.getItem('codev-lists-expanded') === '1';
    } catch {
      return false;
    }
  });
  const [viewingListId, setViewingListId] = useState<string | null>(null);
  const [confirmDeleteListId, setConfirmDeleteListId] = useState<string | null>(null);
  const [listsNotice, setListsNotice] = useState<string | null>(null);
  // Set when the lists store exists but cannot be trusted as written — a
  // file an earlier build wrote, or hand-edited. Persistent until repaired
  // or until a readable store is pushed; carries what a repair would keep.
  const [listsStoreProblem, setListsStoreProblem] = useState<{
    parseable: boolean;
    rawLists: number;
    rawMembers: number;
    keptLists: number;
    keptMembers: number;
  } | null>(null);
  // One dialog for two jobs: naming a new list (`count` set) and renaming an
  // existing one (`renameId` set). Same input, same keys, one code path.
  const [saveListPrompt, setSaveListPrompt] = useState<{
    name: string;
    count: number;
    renameId?: string;
  } | null>(null);
  // Rows a scope needs that are outside the loaded list (list members, live
  // sessions older than the window), fetched by id — same mechanism as pins.
  const [extraScopeSessions, setExtraScopeSessions] = useState<ListViewSession[]>([]);
  const extraScopeSessionsRef = useRef<ListViewSession[]>([]);
  const extraScopeKeyRef = useRef('');
  const viewingListRef = useRef<SessionList | null>(null);
  // Keep the selection on the same session after pin/hide reshuffles the list
  const reanchorSelectionRef = useRef<string | null>(null);
  const hoverSuppressTokenRef = useRef(0);
  const modeRef = useRef<SwitcherMode>(initialMode);
  const activeStateRef = useRef<Record<string, number>>({});
  const allSessionsRef = useRef<ListViewSession[]>([]);
  const lastAssistantFetchRef = useRef<Record<string, number>>({});
  const sessionSearchRef2 = useRef(''); // tracks current search value for use in closures
  const deepSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepSearchSeqRef = useRef(0);
  // Bumped when a deep-search response lands, so the single filtering site
  // (the refresh effect) reruns with current state instead of a stale closure.
  const [deepSearchRev, setDeepSearchRev] = useState(0);
  const deepMatchesRef = useRef<ListViewSession[]>([]); // latest main-side full-prompt matches
  // Set true when a session is opened; on the next window show, clear the search so
  // returning to Sessions shows the full list. Toggling away without selecting keeps it.
  const clearSessionSearchOnShowRef = useRef(false);
  const [currentAppMode, setCurrentAppMode] = useState('menubar');
  const [modeBanner, setModeBanner] = useState<string | null>(null);
  const [quickSwitcherShortcut, setQuickSwitcherShortcut] = useState('');
  const [settingsOpenToTab, setSettingsOpenToTab] = useState<'general' | 'sessions' | 'shortcuts' | null>(null);
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const terminalBadge = terminalApps[s.sessionId] || ((s as any).entrypoint === 'claude-vscode' ? 'vscode' : '');
      // The session id is searchable too — by the prefix rule in
      // matchesSessionId, shared with the main-side searchClaudeSessions so
      // both paths agree on what an id query is (#142: the id is the one
      // field that stays unique when several sessions share a name).
      // A saved-list member whose session is gone has only what was captured;
      // search those fields too, or a query on its captured title drops it.
      const captured = s.__listMember;
      const capturedText = captured
        ? `${captured.title || ''} ${captured.branch || ''} ${captured.recap?.text || ''} ${captured.lastUserMessage || ''} ${captured.lastAssistantMessage || ''}`
        : '';
      const searchTarget = `${s.projectName} ${s.project} ${s.firstUserMessage} ${s.lastUserMessage} ${customTitles[s.sessionId] || ''} ${branches[s.sessionId] || ''} ${prInfo ? `PR #${prInfo.prNumber} ${prInfo.prUrl}` : ''} ${assistantResponses[s.sessionId] || ''} ${terminalBadge} ${capturedText}`.toLowerCase();
      return matchesAllWordsOrId(searchTarget, s.sessionId, words);
    });
  };

  // Union of the local field filter and the latest main-side full-prompt search
  // results (issue #131). Deep matches outside the loaded list are appended,
  // then everything re-sorts into the usual recency order.
  const applySearchFilter = (allItems: any[], query: string) => {
    // Pins outside the loaded window are only in the by-id fetch, and their
    // title / branch / PR live in renderer enrichment the main-side prompt
    // search cannot see — without widening the candidate set here, searching
    // for such a pin's title finds nothing, and in pinned-only mode that reads
    // as "no pinned session matches" for a pin that is visible while browsing.
    // Only while a query is live: this runs on every keystroke including the
    // one that empties the box, and widening the browse list is not this
    // function's job.
    // While viewing a saved list, members the by-id fetch could not resolve
    // exist only as captured records; give them a placeholder row here so a
    // query on a captured field keeps them, the way the list view itself
    // renders them. mergeSessionsById keeps the first occurrence, so resolved
    // members are untouched.
    const listPlaceholders: ListViewSession[] = (
      viewingListRef.current?.members ?? []
    ).map((m) => ({
      sessionId: m.sessionId,
      project: m.project,
      projectName: m.projectName,
      firstUserMessage: '',
      lastUserMessage: m.lastUserMessage || '',
      lastTimestamp: m.lastTimestamp,
      messageCount: undefined,
      isActive: false,
      accountLabel: m.accountLabel,
      __listMember: m,
    }));
    const candidates = query.trim()
      ? mergeSessionsById(
          mergeSessionsById(
            mergeSessionsById(allItems, extraPinnedSessionsRef.current),
            extraScopeSessionsRef.current,
          ),
          listPlaceholders,
        )
      : allItems;
    const base = filterSessionsLocally(candidates, query);
    if (!query.trim() || deepMatchesRef.current.length === 0) return base;
    const seen = new Set(base.map((s: any) => s.sessionId));
    const extra = deepMatchesRef.current
      .filter((s: any) => !seen.has(s.sessionId))
      .map((s: any) => ({
        ...s,
        isActive: s.sessionId in activeStateRef.current,
        activePid: activeStateRef.current[s.sessionId],
      }));
    if (extra.length === 0) return base;
    const merged = [...base, ...extra];
    merged.sort(
      (a: any, b: any) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0),
    );
    return merged;
  };

  // Every enrichment response lands the same way; one function so a field
  // added to the response (recaps) cannot be picked up at three call sites
  // and forgotten at the fourth.
  const applyEnrichment = (enrichment: {
    titles?: Record<string, string>;
    branches?: Record<string, string>;
    prLinks?: Record<string, { prNumber: number; prUrl: string }>;
    recaps?: Record<string, { text: string; at: string }>;
  }) => {
    if (enrichment.titles && Object.keys(enrichment.titles).length > 0) {
      setCustomTitles((prev: Record<string, string>) => ({ ...prev, ...enrichment.titles }));
    }
    if (enrichment.branches && Object.keys(enrichment.branches).length > 0) {
      setBranches((prev: Record<string, string>) => ({ ...prev, ...enrichment.branches }));
    }
    if (enrichment.prLinks && Object.keys(enrichment.prLinks).length > 0) {
      setPrLinks((prev) => ({ ...prev, ...enrichment.prLinks }));
    }
    if (enrichment.recaps && Object.keys(enrichment.recaps).length > 0) {
      setRecaps((prev) => ({ ...prev, ...enrichment.recaps }));
    }
  };

  // Debounced main-side search over ALL sessions × ALL user prompts.
  const scheduleDeepSearch = (query: string) => {
    if (deepSearchTimerRef.current) clearTimeout(deepSearchTimerRef.current);
    deepMatchesRef.current = [];
    const seq = ++deepSearchSeqRef.current;
    if (!query.trim()) {
      setSearchSnippets({});
      return;
    }
    deepSearchTimerRef.current = setTimeout(async () => {
      const res = await window.electronAPI.searchClaudeSessions(query);
      // Drop stale responses (query changed while this one was in flight)
      if (seq !== deepSearchSeqRef.current || sessionSearchRef2.current !== query) return;
      deepMatchesRef.current = res?.sessions || [];
      setSearchSnippets(res?.snippets || {});
      // Bump a revision instead of filtering here. This callback was created
      // ~180ms + one IPC round-trip ago and closes over the enrichment maps of
      // THAT render, so filtering now would overwrite fresher results with a
      // stale view. The refresh effect below owns the filtering; it runs from
      // a current render, and this is one of its dependencies.
      setDeepSearchRev((r) => r + 1);
      // Lazy-enrich deep matches that aren't in the loaded list. Bounded by
      // the deep-search result cap (100), same magnitude as the initial load.
      const loaded = new Set(
        allSessionsRef.current.map((s: any) => s.sessionId),
      );
      const appended = deepMatchesRef.current.filter(
        (s: any) => !loaded.has(s.sessionId),
      );
      if (appended.length > 0) {
        window.electronAPI.loadSessionEnrichment(appended).then(applyEnrichment);
        window.electronAPI.loadLastAssistantResponses(appended).then((responses: Record<string, string>) => {
          if (responses && Object.keys(responses).length > 0) {
            setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
          }
        });
      }
    }, 180);
  };

  // `sessions` is a materialized filter result, so anything that arrives after
  // the query was typed is invisible to it: the by-id pin fetch, and the
  // title / branch / PR / last-reply enrichment those rows are matched on.
  // Without this, a row that matches only on a late-arriving field stays
  // missing until the next keystroke — and in pinned-only mode that reads as
  // "no pinned session matches" for a pin you can see while browsing.
  useEffect(() => {
    const search = sessionSearchRef2.current;
    if (!search.trim()) return;
    setSessions((prev: any[]) => {
      const next = applySearchFilter(allSessionsRef.current, search);
      // Identical rows in identical order → keep the old array. Some of the
      // deps below are refreshed by polling, and a fresh array every tick
      // would re-render the list for nothing.
      if (
        next.length === prev.length &&
        next.every((s: any, i: number) => s.sessionId === prev[i].sessionId)
      ) {
        return prev;
      }
      return next;
    });
  }, [
    deepSearchRev,
    customTitles,
    branches,
    prLinks,
    assistantResponses,
    terminalApps,
    extraPinnedSessions,
    extraScopeSessions,
  ]);

  const isSearchingSessions = sessionSearchValue.trim().length > 0;
  const searchWordsLower = sessionSearchValue
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  // One rule for every length-capped line in a row: while searching, the window
  // moves to the first match so you can see WHY the row is in the results;
  // otherwise it keeps both ends, because these titles put the newest step last.
  const fitToRow = (text: string, max: number) =>
    isSearchingSessions
      ? windowAroundMatch(text, searchWordsLower, max)
      : truncateMiddle(text, max);
  const hiddenSet = new Set(sessionMarks.hidden);
  const hasPins = Object.keys(sessionMarks.pins).length > 0;
  const viewingList =
    viewingListId ? sessionLists.find((l) => l.id === viewingListId) ?? null : null;
  // Mirrored into a ref for applySearchFilter, which runs from debounced
  // timeouts and setState updaters (the stale-closure trap, see above).
  viewingListRef.current = viewingList;
  // Process facts by session, plus a synthetic row for every running process
  // that has no session row to carry them: no id at all (the "unregistered"
  // case the live view exists for), or an id the session list does not know —
  // a session with no prompt yet, or one the by-id fetch has not returned.
  // Either way the live scope must show every process the chip counted; the
  // first live test caught "33 live" beside a 32-row list.
  const liveBySession: Record<string, LiveRowInfo> = {};
  const liveOrphans: ListViewSession[] = [];
  const knownById = new Map<string, ListViewSession>();
  for (const s of allSessions) knownById.set(s.sessionId, s);
  for (const s of extraScopeSessions) {
    if (!knownById.has(s.sessionId)) knownById.set(s.sessionId, s);
  }
  // Which process represents a session that has several? The one the
  // registration-based detection mapped to it — IF that pid is still in the
  // live report; the detection's map is cached and can name a process that
  // has since been replaced. Otherwise the first live process on that id.
  // Choosing from the report, not the cache, is what keeps a stale map from
  // classifying every current process as an "extra" row.
  const livePidsById = new Map<string, number[]>();
  for (const p of liveReport?.live ?? []) {
    if (!p.sessionId) continue;
    const pids = livePidsById.get(p.sessionId) ?? [];
    pids.push(p.pid);
    livePidsById.set(p.sessionId, pids);
  }
  const representativeOf = (id: string): number | undefined => {
    const pids = livePidsById.get(id) ?? [];
    const mapped = activeStateRef.current[id];
    return mapped !== undefined && pids.includes(mapped) ? mapped : pids[0];
  };
  for (const p of liveReport?.live ?? []) {
    const info: LiveRowInfo = {
      pid: p.pid,
      rssKb: p.rssKb,
      tty: p.tty,
      uptimeSec: p.uptimeSec,
      registered: p.registered,
    };
    const id = p.sessionId;
    const known = id ? knownById.get(id) : undefined;
    if (id && known) {
      // A real row represents ONE process. Any other process on the same id
      // (a resumed copy, a /branch parent and child) gets a row of its own —
      // the chip counts processes, so the list must show processes, and the
      // memory total must add every one of them.
      if (representativeOf(id) === p.pid) {
        liveBySession[id] = info;
        continue;
      }
      liveOrphans.push({
        ...known,
        isActive: true,
        activePid: p.pid,
        __live: info,
        __liveExtra: true,
      });
      continue;
    }
    if (id && representativeOf(id) === p.pid) liveBySession[id] = info;
    liveOrphans.push({
      sessionId: id || `pid:${p.pid}`,
      project: p.cwd || '',
      projectName: (p.cwd || '').split('/').filter(Boolean).pop() || `pid ${p.pid}`,
      accountLabel: p.accountLabel,
      accountIsAnchor: p.accountIsAnchor,
      firstUserMessage: '',
      lastUserMessage: '',
      lastTimestamp: 0,
      messageCount: undefined,
      isActive: true,
      activePid: p.pid,
      __liveOrphan: !id,
      __live: info,
    });
  }
  // A live session older than the loaded window is only in the by-id fetch;
  // widen the browse list so the live scope can see it (search widens its
  // own candidates the same way).
  const scopedSessions =
    liveOnly && !viewingList && !isSearchingSessions
      ? mergeSessionsById(sessions, extraScopeSessions)
      : sessions;
  // Which rows appear, in which group, in which order — one pure function so
  // the browse-state matrix (search x scopes x grouped) is testable without
  // running the app. See src/session-list-view.ts.
  const {
    pinnedRows,
    visiblePinnedRows,
    minorSessions,
    displayedSessions,
    minorFoldHeaderIndex,
    hiddenMinorCount,
    pinnedOnlyActive,
    liveOnlyActive,
    listViewActive,
    canGroupPins,
  } = buildSessionListView({
    sessions: scopedSessions,
    allSessions,
    extraPinnedSessions,
    pins: sessionMarks.pins,
    hidden: sessionMarks.hidden,
    activePids: activeStateRef.current,
    hasCustomTitle: (id: string) => !!customTitles[id],
    hasPrLink: (id: string) => !!prLinks[id],
    isSearching: isSearchingSessions,
    pinnedOnly,
    pinnedCollapsed,
    minorsExpanded,
    activeDetectionReady,
    liveOnly,
    liveBySession,
    liveOrphans,
    viewingList,
    extraListSessions: extraScopeSessions,
  });
  const liveCount = liveReport
    ? liveReport.live.length
    : Object.keys(activeStateRef.current).length;
  const staleCount = liveReport?.staleRegistrations.length ?? 0;
  // Memory of the rows on screen — not of every live process — so the figure
  // beside a search result describes the result.
  const displayedRssKb = liveOnlyActive
    ? displayedSessions.reduce((sum, s) => {
        const live = s.__live || liveBySession[s.sessionId];
        return sum + (live?.rssKb ?? 0);
      }, 0)
    : 0;
  // Manually hidden sessions may be titled/long — keep the fold label honest.
  const minorFoldSuffix =
    hiddenMinorCount > 0
      ? `(≤2 msgs, untitled · ${hiddenMinorCount} hidden)`
      : '(≤2 msgs, untitled)';

  // Pin/hide moves rows under a STATIONARY cursor; Chromium then re-hit-tests
  // and fires mouseenter on whatever row slid under the mouse, teleporting the
  // selection (and overriding the re-anchor below) — the same phenomenon the
  // window-show code suppresses with ignoreMouseEnterRef. Suppress it around
  // every marks-driven layout change too.
  const suppressHoverSelection = (ms = 400) => {
    ignoreMouseEnterRef.current = true;
    const token = ++hoverSuppressTokenRef.current;
    setTimeout(() => {
      if (hoverSuppressTokenRef.current === token) {
        ignoreMouseEnterRef.current = false;
      }
    }, ms);
  };

  // Arm the re-anchor together with the marks update (same commit): arming at
  // toggle-call time let any unrelated render consume the ref before the list
  // actually reshuffled, leaving the selection on the wrong row again.
  const applyMarksResult = (r: any, reanchorSessionId?: string) => {
    if (r?.ok && r.marks) {
      if (reanchorSessionId) reanchorSelectionRef.current = reanchorSessionId;
      suppressHoverSelection();
      setSessionMarks({ pins: r.marks.pins || {}, hidden: r.marks.hidden || [] });
    }
  };
  const togglePin = (session: any) => {
    if (sessionMarks.pins[session.sessionId]) {
      window.electronAPI
        .unpinSession(session.sessionId)
        .then((r) => applyMarksResult(r, session.sessionId))
        .catch(() => {});
    } else {
      window.electronAPI
        .pinSession(session.sessionId, { cwd: session.project, accountLabel: session.accountLabel })
        .then((r) => applyMarksResult(r, session.sessionId))
        .catch(() => {});
    }
  };
  const toggleHide = (session: any) => {
    if (hiddenSet.has(session.sessionId)) {
      window.electronAPI
        .unhideSession(session.sessionId)
        .then((r) => applyMarksResult(r, session.sessionId))
        .catch(() => {});
    } else {
      window.electronAPI
        .hideSession(session.sessionId)
        .then((r) => applyMarksResult(r, session.sessionId))
        .catch(() => {});
    }
  };
  // Persist the two header toggles from effects, never from inside a state
  // updater: an updater must be pure (React is free to call it more than once),
  // and one effect owning each key means no second writer can disagree with it
  // about what is stored — the reset below just sets state and this follows.
  useEffect(() => {
    try {
      localStorage.setItem(
        'codev-pinned-collapsed',
        pinnedCollapsed ? '1' : '0',
      );
    } catch {
      // Best effort: a browsing preference is not worth failing a render over
      // (localStorage throws when the quota is full or storage is blocked).
      // The in-memory state stays correct; only the next launch forgets it.
    }
  }, [pinnedCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem('codev-pinned-only', pinnedOnly ? '1' : '0');
    } catch {
      // Best effort, same as above.
    }
  }, [pinnedOnly]);
  const togglePinnedCollapsed = () => {
    setPinnedCollapsed((prev) => !prev);
    // The list just changed length — snap the selection back to the top,
    // same as the minors fold collapse does.
    setSelectedSessionIndex(0);
  };
  // Pinned-only needs pins to mean anything, so an empty pin set must clear the
  // stored preference — otherwise the next pin, possibly weeks later, silently
  // collapses the list to that one row.
  //
  // Gated on the marks having actually loaded, not on having seen pins earlier
  // in this run: at mount the pin set is empty simply because the IPC load has
  // not landed, and an ungated `!hasPins` check would wipe a legitimately
  // stored preference. Watching for a non-empty → empty transition instead
  // would only cover the case where the last pin is removed while the app is
  // running, and miss the one where it is already gone at launch (a reset or
  // hand-edited marks file) — which is the same footgun, one restart later.
  useEffect(() => {
    if (!marksLoaded || hasPins || !pinnedOnly) return;
    setPinnedOnly(false);
  }, [marksLoaded, hasPins, pinnedOnly]);
  const togglePinnedOnly = () => {
    setPinnedOnly((prev) => !prev);
    setSelectedSessionIndex(0);
  };

  // --- Live scope (issue #94) ---
  useEffect(() => {
    try {
      localStorage.setItem('codev-live-stats', liveStats ? '1' : '0');
    } catch {
      // Best effort, same as the pinned toggles.
    }
  }, [liveStats]);
  const refreshLiveReport = async () => {
    try {
      // null = "could not look" (a failed ps); keep the last good report.
      const r = await window.electronAPI.getLiveSessions();
      if (r) setLiveReport(r);
    } catch {
      // Same: never replace a good report with nothing.
    }
  };
  const toggleLiveOnly = () => {
    const next = !liveOnly;
    liveOnlyRef.current = next;
    setLiveOnly(next);
    // Scopes are exclusive: entering one leaves the other.
    if (next) setViewingListId(null);
    setSelectedSessionIndex(0);
    if (next) refreshLiveReport();
  };

  // --- Saved lists (issue #145) ---
  useEffect(() => {
    try {
      localStorage.setItem('codev-lists-expanded', listsExpanded ? '1' : '0');
    } catch {
      // Best effort, same as the pinned toggles.
    }
  }, [listsExpanded]);
  // A refused write must be visible. The store refuses (rather than
  // overwrites) when it cannot trust what is on disk; the first live test
  // hit that and saw nothing at all, which read as "the button is broken".
  const listsNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showListsNotice = (text: string) => {
    setListsNotice(text);
    if (listsNoticeTimerRef.current) clearTimeout(listsNoticeTimerRef.current);
    listsNoticeTimerRef.current = setTimeout(() => setListsNotice(null), 6000);
  };
  const applyListsResult = (r: ListsWriteResult | undefined) => {
    if (r?.ok && r.lists) {
      setSessionLists(r.lists.lists || []);
      setListsLoaded(true);
    } else if (r && !r.ok) {
      showListsNotice(
        r.error === 'lists store unreadable'
          ? 'Not saved: ~/.config/codev/session-lists.json cannot be read as-is — fix or remove it'
          : `Not saved: ${r.error || 'unknown error'}`,
      );
    }
  };
  const openList = (id: string) => {
    liveOnlyRef.current = false;
    setLiveOnly(false);
    setViewingListId(id);
    setConfirmDeleteListId(null);
    setSelectedSessionIndex(0);
    // Members resolve their running state from the ps join as well as the
    // registration map (see activeFrom in session-list-view.ts), so viewing a
    // list refreshes the report too — one `ps`, and a click switches instead
    // of resuming a second copy.
    refreshLiveReport();
  };
  const closeList = () => {
    setViewingListId(null);
    setSelectedSessionIndex(0);
  };
  const deleteList = async (id: string) => {
    try {
      const r = await window.electronAPI.deleteSessionList(id);
      applyListsResult(r);
      setConfirmDeleteListId(null);
      if (r?.ok && viewingListId === id) setViewingListId(null);
    } catch {
      showListsNotice('delete failed');
    }
  };
  // What gets saved is exactly what is on screen, minus rows that are not
  // sessions (orphan processes have no id to resume). Every field is what the
  // renderer already holds for the row; nothing is re-read from disk.
  const captureDisplayedSessions = (): SessionListMember[] =>
    displayedSessions
      .filter((s) => !s.__liveOrphan)
      .map((s) => ({
        sessionId: s.sessionId,
        project: s.project || '',
        projectName: s.projectName || '',
        accountLabel: s.accountLabel,
        title: customTitles[s.sessionId] || s.__listMember?.title,
        branch: branches[s.sessionId] || s.__listMember?.branch,
        pinned: !!sessionMarks.pins[s.sessionId],
        lastTimestamp: s.lastTimestamp || 0,
        recap: recaps[s.sessionId] || s.__listMember?.recap,
        lastUserMessage: s.lastUserMessage || undefined,
        lastAssistantMessage:
          assistantResponses[s.sessionId] || s.__listMember?.lastAssistantMessage,
      }));
  const openSaveListPrompt = () => {
    const count = displayedSessions.filter((s) => !s.__liveOrphan).length;
    if (count === 0) return;
    setSaveListPrompt({ name: nextListName(sessionLists.map((l) => l.name)), count });
  };
  // Closing the dialog unmounts the focused input, which drops focus to the
  // body — arrow keys then go nowhere until a click lands on something (the
  // document click handler is what refocuses the search box). Hand focus
  // back explicitly, for Enter and for Esc alike.
  const closeSaveListPrompt = () => {
    setSaveListPrompt(null);
    setTimeout(() => sessionSearchRef.current?.focus(), 0);
  };
  const openRenameListPrompt = (id: string) => {
    const current = sessionLists.find((l) => l.id === id);
    if (!current) return;
    setSaveListPrompt({ name: current.name, count: current.members.length, renameId: id });
  };
  const saveList = async () => {
    if (!saveListPrompt) return;
    if (saveListPrompt.renameId) {
      // Rename: an empty name keeps the old one (the store does the same).
      const id = saveListPrompt.renameId;
      const name = saveListPrompt.name.trim();
      closeSaveListPrompt();
      if (!name) return;
      try {
        applyListsResult(await window.electronAPI.renameSessionList(id, name));
      } catch {
        showListsNotice('rename failed');
      }
      return;
    }
    const members = captureDisplayedSessions();
    const name =
      saveListPrompt.name.trim() || nextListName(sessionLists.map((l) => l.name));
    closeSaveListPrompt();
    try {
      const r = await window.electronAPI.saveSessionList(name, members);
      applyListsResult(r);
      if (r?.ok) setListsExpanded(true);
    } catch {
      showListsNotice('save failed');
    }
  };

  // Load lists once + subscribe to main-side pushes — the same shape, and the
  // same two guards, as the marks effect below: a push that already landed
  // outranks the in-flight snapshot, and an unknown read is never applied.
  useEffect(() => {
    window.electronAPI
      .getSessionLists()
      .then((r: ListsResponse | undefined) => {
        if (!r || listsPushSeenRef.current) return;
        if (r.known === false) {
          // Do not apply the (empty) value — but do say why the list is
          // empty, with the numbers a repair would keep. Silence here read
          // as "my list was deleted" in the second live test.
          setListsStoreProblem(
            r.inspection ?? {
              parseable: false,
              rawLists: 0,
              rawMembers: 0,
              keptLists: 0,
              keptMembers: 0,
            },
          );
          return;
        }
        setSessionLists(r.lists || []);
        setListsLoaded(true);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.onSessionListsUpdated(
      (_event: unknown, r: { lists?: SessionList[] } | undefined) => {
        if (!r) return;
        listsPushSeenRef.current = true;
        setSessionLists(r.lists || []);
        setListsLoaded(true);
        // A push is an authoritative read by construction.
        setListsStoreProblem(null);
      },
    );
    return unsubscribe;
  }, []);

  // A list that was deleted (here or by hand) cannot stay open.
  useEffect(() => {
    if (!listsLoaded || !viewingListId) return;
    if (!sessionLists.some((l) => l.id === viewingListId)) setViewingListId(null);
  }, [listsLoaded, sessionLists, viewingListId]);

  // Fetch by id the rows a scope needs that the loaded list does not have:
  // the members of the list being viewed, and live sessions older than the
  // window. Same key-compare as the pins fetch, so a re-render is free.
  useEffect(() => {
    const loaded = new Set(allSessions.map((s: any) => s.sessionId));
    const wanted = new Set<string>();
    for (const m of viewingList?.members ?? []) wanted.add(m.sessionId);
    for (const p of liveReport?.live ?? []) {
      if (p.sessionId) wanted.add(p.sessionId);
    }
    const missing = [...wanted].filter((id) => !loaded.has(id));
    const key = missing.sort().join(',');
    if (key === extraScopeKeyRef.current) return;
    extraScopeKeyRef.current = key;
    if (missing.length === 0) {
      extraScopeSessionsRef.current = [];
      setExtraScopeSessions([]);
      return;
    }
    window.electronAPI
      .getSessionsByIds(missing)
      .then((result: any[]) => {
        if (extraScopeKeyRef.current !== key) return;
        const found = result || [];
        extraScopeSessionsRef.current = found;
        setExtraScopeSessions(found);
        if (found.length === 0) return;
        window.electronAPI.loadSessionEnrichment(found).then(applyEnrichment);
        window.electronAPI
          .loadLastAssistantResponses(found)
          .then((responses: Record<string, string>) => {
            if (responses && Object.keys(responses).length > 0) {
              setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
            }
          });
      })
      .catch(() => {});
  }, [viewingList, liveReport, allSessions]);

  // Pinning/hiding inserts or removes rows above the selection, shifting every
  // index — without re-anchoring, the next ⌘D would act on an unintended row.
  // Re-anchor to the same session's LAST occurrence (the timeline copy).
  useEffect(() => {
    const target = reanchorSelectionRef.current;
    if (!target) return;
    reanchorSelectionRef.current = null;
    let next = -1;
    for (let i = displayedSessions.length - 1; i >= 0; i--) {
      if (displayedSessions[i].sessionId === target) {
        next = i;
        break;
      }
    }
    if (next >= 0) {
      setSelectedSessionIndex(next);
    } else {
      // The session left the visible list (hidden into a collapsed fold) —
      // just clamp the selection into range.
      setSelectedSessionIndex((cur) =>
        Math.min(cur, Math.max(displayedSessions.length - 1, 0)),
      );
    }
  });

  // Load marks once + subscribe to main-side pushes (fs.watch on the store)
  useEffect(() => {
    window.electronAPI
      .getSessionMarks()
      .then((m: any) => {
        if (!m) return;
        // A watcher push that has already landed is newer than this response by
        // definition — the store changed after we asked. Applying the in-flight
        // snapshot on top of it would roll the pin set back, and an emptier
        // snapshot would then clear and PERSIST pinnedOnly.
        if (marksPushSeenRef.current) return;
        // Guard BEFORE touching state: an unknown read carries empty marks,
        // and applying them would hide valid pins from the UI until something
        // else re-reads the store.
        if (m.known === false) return;
        setSessionMarks({
          pins: m.pins || {},
          hidden: m.hidden || [],
        });
        // Only an AUTHORITATIVE read makes the pin set trustworthy. A
        // rejection, a nullish payload, or `known: false` (the store exists
        // but could not be parsed — main returns empty marks either way) all
        // leave it UNKNOWN rather than empty, and the pinned-only reset must
        // never act on unknown: it would wipe a valid stored preference on a
        // transient filesystem failure, which is the exact damage that reset
        // exists to prevent. Not clearing is the safe direction; the watcher
        // below promotes the flag if the store becomes readable later.
        setMarksLoaded(true);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.onSessionMarksUpdated(
      (_event: any, m: any) => {
        if (m) {
          marksPushSeenRef.current = true;
          suppressHoverSelection();
          setSessionMarks({
            pins: m.pins || {},
            hidden: m.hidden || [],
          });
          // A push is a real read: the main-side watcher drops unknown reads
          // rather than broadcasting them, so arriving here means the store
          // was parsed successfully.
          setMarksLoaded(true);
        }
      },
    );
    return unsubscribe;
  }, []);

  // Fetch pinned sessions that aren't in the loaded list (by id), then enrich
  useEffect(() => {
    const loaded = new Set(allSessions.map((s: any) => s.sessionId));
    const missing = Object.keys(sessionMarks.pins).filter((id) => !loaded.has(id));
    const key = missing.sort().join(',');
    if (key === extraPinnedKeyRef.current) return;
    extraPinnedKeyRef.current = key;
    if (missing.length === 0) {
      extraPinnedSessionsRef.current = [];
      setExtraPinnedSessions([]);
      return;
    }
    window.electronAPI.getSessionsByIds(missing).then((result: any[]) => {
      // Drop stale responses (a newer pin set superseded this request)
      if (extraPinnedKeyRef.current !== key) return;
      const found = result || [];
      extraPinnedSessionsRef.current = found;
      setExtraPinnedSessions(found);
      if (found.length === 0) return;
      window.electronAPI.loadSessionEnrichment(found).then(applyEnrichment);
      window.electronAPI.loadLastAssistantResponses(found).then((responses: Record<string, string>) => {
        if (responses && Object.keys(responses).length > 0) {
          setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
        }
      });
    }).catch(() => {});
  }, [sessionMarks.pins, allSessions]);

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
    allSessionsRef.current = newSessions;
    // Read via ref, not state: this runs from persistent callbacks (window
    // focus, mode toggle) whose closure would hold a stale sessionSearchValue.
    const search = sessionSearchRef2.current;
    setSessions(
      search.trim() ? applySearchFilter(newSessions, search) : newSessions,
    );

    // Step 2: Load last assistant responses for all sessions (first 100)
    window.electronAPI.loadLastAssistantResponses((result || []).slice(0, 100)).then((responses: Record<string, string>) => {
      if (responses && Object.keys(responses).length > 0) {
        setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
      }
    });

    // Step 3: Detect active sessions in background (spawns processes)
    window.electronAPI.detectActiveSessions().then((result: any) => {
      const activeMap: Record<string, number> = result?.activeMap || {};
      const vscodeSessions: any[] = result?.vscodeSessions || [];
      const entrypointMap: Record<string, string> = result?.entrypoints || {};

      // Save to ref for SWR on next refresh
      activeStateRef.current = activeMap;
      setActiveDetectionReady(true);

      const updateActive = (list: any[]) => {
        // Mark existing sessions as active/inactive
        const updated = list.map((s: any) => ({
          ...s,
          isActive: s.sessionId in activeMap,
          activePid: activeMap[s.sessionId],
          entrypoint: entrypointMap[s.sessionId] || s.entrypoint,
        }));
        // Merge VS Code sessions that aren't already in the list
        for (const vs of vscodeSessions) {
          if (!updated.find((s: any) => s.sessionId === vs.sessionId)) {
            updated.push({ ...vs, entrypoint: 'claude-vscode' });
          }
        }
        // Re-sort by lastTimestamp descending
        updated.sort((a: any, b: any) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
        return updated;
      };
      setAllSessions((prev: any[]) => { const r = updateActive(prev); allSessionsRef.current = r; return r; });
      setSessions((prev: any[]) => {
        const updated = updateActive(prev);
        const search = sessionSearchRef2.current;
        return search.trim() ? applySearchFilter(updated, search) : updated;
      });

      if (Object.keys(activeMap).length > 0) {
        // Detect terminal apps for active sessions (pass entrypoints to skip process tree walk for VS Code)
        window.electronAPI.detectTerminalApps(activeMap, entrypointMap).then((apps: Record<string, string>) => {
          if (apps && Object.keys(apps).length > 0) {
            setTerminalApps((prev: Record<string, string>) => ({ ...prev, ...apps }));
          }
        });
      }

      // Load enrichment (ai-title, branch, PR) for active VS Code sessions
      const allVSCode = [...vscodeSessions]; // collect for combined enrichment with closed
      if (vscodeSessions.length > 0) {
        // Use pre-loaded assistant responses (already read from tail in detectActiveSessions)
        const preloaded: Record<string, string> = {};
        for (const vs of vscodeSessions) {
          if (vs.lastAssistantMessage) preloaded[vs.sessionId] = vs.lastAssistantMessage;
        }
        if (Object.keys(preloaded).length > 0) {
          setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...preloaded }));
        }
      }

      // Step 5: Scan closed VS Code sessions (reuse activeMap from Step 3, no duplicate call)
      const activeIds = Object.keys(activeMap);
      window.electronAPI.scanClosedVSCodeSessions(activeIds).then((closedVS: any[]) => {
        if (closedVS && closedVS.length > 0) {
          // Merge closed VS Code sessions, deduplicate, sort, cap at 100
          const mergeAndCap = (prev: any[]) => {
            const existingIds = new Set(prev.map((s: any) => s.sessionId));
            const newSessions = closedVS.filter((s: any) => !existingIds.has(s.sessionId));
            if (newSessions.length === 0) return prev;
            const merged = [...prev, ...newSessions];
            merged.sort((a: any, b: any) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
            return merged.slice(0, 100);
          };
          setAllSessions((prev: any[]) => { const r = mergeAndCap(prev); allSessionsRef.current = r; return r; });
          setSessions((prev: any[]) => {
            const merged = mergeAndCap(prev);
            const search = sessionSearchRef2.current;
            return search.trim() ? applySearchFilter(merged, search) : merged;
          });
          allVSCode.push(...closedVS);
          // Use pre-loaded assistant responses from closed sessions
          const preloaded: Record<string, string> = {};
          for (const vs of closedVS) {
            if (vs.lastAssistantMessage) preloaded[vs.sessionId] = vs.lastAssistantMessage;
          }
          if (Object.keys(preloaded).length > 0) {
            setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...preloaded }));
          }
        }
        // Load enrichment for ALL VS Code sessions (active + closed) in one call
        if (allVSCode.length > 0) {
          window.electronAPI.loadSessionEnrichment(allVSCode).then(applyEnrichment);
        }
      });
    });

    // Step 4: Load custom titles + branches in background
    if (result && result.length > 0) {
      window.electronAPI.loadSessionEnrichment(result.slice(0, 100)).then(applyEnrichment);
    }
    // The live report describes processes, which change independently of
    // history.jsonl. Refresh it with EVERY session refetch, not only in the
    // live scope: rows resolve their running pid from the report (it beats
    // the cached detection map), so a report older than the map would hand a
    // click a dead pid. One `ps` per popup open — `detectTerminalApps` on the
    // same trigger spawns a few hundred.
    refreshLiveReport();
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

    // Account count decides whether the ⌥⌘+Enter picker hint is shown.
    // Re-checked when the embedded Settings popup mutates accounts (same-window
    // CustomEvent) and on window focus (covers CLI-side changes) — no restart
    // needed for the hint to switch.
    const refreshMultiAccountHint = () => {
      window.electronAPI
        .getAccounts()
        .then((r) => {
          if (r.ok) setIsMultiAccountUI(((r.accounts || []) as unknown[]).length > 1);
        })
        .catch(() => {});
    };
    refreshMultiAccountHint();
    window.addEventListener('codev-accounts-changed', refreshMultiAccountHint);
    window.addEventListener('focus', refreshMultiAccountHint);

    // If initial mode is sessions (from URL hash), fetch sessions immediately
    if (initialMode === 'sessions') {
      fetchClaudeSessions();
    }

    // Session status updates from hooks (fs.watch)
    window.electronAPI.getSessionStatuses().then((rawStatuses: Record<string, any>) => {
      if (!rawStatuses) return;
      const statusStrings: Record<string, string> = {};
      for (const [id, v] of Object.entries(rawStatuses)) {
        statusStrings[id] = typeof v === 'object' ? v.status : v;
      }
      setSessionStatuses(statusStrings);
    });
    window.electronAPI.onSessionStatusesUpdated((_event: any, rawStatuses: Record<string, any>) => {
      // Extract status strings for dots display
      const statusStrings: Record<string, string> = {};
      for (const [id, v] of Object.entries(rawStatuses)) {
        statusStrings[id] = typeof v === 'object' ? v.status : v;
      }
      setSessionStatuses(statusStrings);

      // Auto-refresh preview (user msg + assistant msg + order) for idle sessions
      const currentSessions = allSessionsRef.current;
      const sessionsToRefresh: any[] = [];
      for (const [id, v] of Object.entries(rawStatuses)) {
        const status = typeof v === 'object' ? v.status : v;
        const ts = typeof v === 'object' ? (v.timestamp || 0) : 0;
        if (status !== 'idle' || !ts) continue;
        const lastFetched = lastAssistantFetchRef.current[id] || 0;
        if (ts * 1000 > lastFetched) {
          const s = currentSessions.find((s: any) => s.sessionId === id);
          if (s?.project) sessionsToRefresh.push(s);
        }
      }
      if (sessionsToRefresh.length > 0) {
        const now = Date.now();
        for (const s of sessionsToRefresh) {
          lastAssistantFetchRef.current[s.sessionId] = now;
        }
        // Small delay to ensure JSONL is fully flushed after Stop hook
        setTimeout(() => {
          window.electronAPI.refreshSessionPreview(sessionsToRefresh).then((previews: Record<string, any>) => {
            if (!previews || Object.keys(previews).length === 0) return;
            // Update assistant responses
            const newAssistant: Record<string, string> = {};
            for (const [id, p] of Object.entries(previews)) {
              if (p.lastAssistantMessage) newAssistant[id] = p.lastAssistantMessage;
            }
            if (Object.keys(newAssistant).length > 0) {
              setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...newAssistant }));
            }
            // Update last user message + timestamp + re-sort
            const refreshedIds = new Set(Object.keys(previews));
            const updateSessions = (list: any[]) => {
              const updated = list.map((s: any) => {
                if (!refreshedIds.has(s.sessionId)) return s;
                const p = previews[s.sessionId];
                return {
                  ...s,
                  lastUserMessage: p.lastUserMessage || s.lastUserMessage,
                  lastTimestamp: now,
                };
              });
              updated.sort((a: any, b: any) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
              return updated;
            };
            setAllSessions((prev: any[]) => { const r = updateSessions(prev); allSessionsRef.current = r; return r; });
            setSessions((prev: any[]) => {
              const updated = updateSessions(prev);
              const search = sessionSearchRef2.current;
              // applySearchFilter, not filterSessionsLocally: the list being
              // re-filtered here already contains deep-search hits, which
              // matched on middle prompts that the local filter's haystack
              // does not contain — running the local filter alone drops every
              // prompt-only match the moment a closed-VS-Code scan lands.
              return search.trim() ? applySearchFilter(updated, search) : updated;
            });
          });
        }, 300);
      }
    });

    // Load shortcut for display
    window.electronAPI.getShortcuts().then((s: any) => {
      if (s?.quickSwitcher) {
        const display = acceleratorToSymbols(s.quickSwitcher);
        setQuickSwitcherShortcut(display);
        shortcutDisplay = display;
      }
    });

    const showBanner = (msg: string, durationMs = 5000) => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
      setModeBanner(msg);
      bannerTimeoutRef.current = setTimeout(() => setModeBanner(null), durationMs);
    };

    // Listen for app mode changes to enable/disable drag
    let shortcutDisplay = ''; // will be set by getShortcuts
    window.electronAPI.getAppMode().then((mode: string) => {
      const m = mode || 'normal';
      setCurrentAppMode(m);
      if (m === 'normal') {
        // Only show the startup banner once (first launch)
        window.electronAPI.getBannerSeen().then((seen: boolean) => {
          if (!seen) {
            showBanner('Normal App mode — drag to reposition. Switch to Menu Bar mode in Settings.', 6000);
            window.electronAPI.setBannerSeen();
          }
        });
      }
    });
    window.electronAPI.onShortcutsUpdated((_event: any, s: any) => {
      if (s?.quickSwitcher) {
        shortcutDisplay = acceleratorToSymbols(s.quickSwitcher);
        setQuickSwitcherShortcut(shortcutDisplay);
      }
    });
    window.electronAPI.onAppModeChanged((_event: any, mode: string) => {
      setCurrentAppMode(mode);
      const key = shortcutDisplay || '⌃⌘R';
      if (mode === 'normal') {
        showBanner('Switched to Normal App mode — window stays visible and is draggable.');
      } else {
        showBanner(`Switched to Menu Bar mode — window auto-hides. Use ${key} to toggle.`);
      }
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
        // Each fresh popup show starts with minor sessions folded again.
        setMinorsExpanded(false);
        // If a session was just opened, reset the search before refetching so the
        // full list shows on return (keyword is kept when merely toggling away).
        if (clearSessionSearchOnShowRef.current) {
          clearSessionSearchOnShowRef.current = false;
          setSessionSearchValue('');
          sessionSearchRef2.current = '';
          scheduleDeepSearch('');
          setSelectedSessionIndex(-1);
          // Drop the stale filtered list immediately so the empty input and the
          // visible list agree before fetchClaudeSessions() resolves.
          setSessions(allSessionsRef.current);
          // A scope is a way of finding one session; once it is opened, the
          // next show starts from the full list, like the search does.
          setViewingListId(null);
          liveOnlyRef.current = false;
          setLiveOnly(false);
        }
        fetchClaudeSessions();
      }
      // Refresh session statuses on window focus
      window.electronAPI.getSessionStatuses().then((rawStatuses: Record<string, any>) => {
        if (!rawStatuses) return;
        const statusStrings: Record<string, string> = {};
        for (const [id, v] of Object.entries(rawStatuses)) {
          statusStrings[id] = typeof v === 'object' ? v.status : v;
        }
        setSessionStatuses(statusStrings);
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
    if (!input) return true;

    let target: string;
    try {
      const branch = projectBranches[candidate?.value] || '';
      // Include both full path and ~/shortened path for matching
      const shortPath = shortenPath(candidate?.value);
      target = (candidate?.value + ' ' + shortPath + ' ' + branch).toLowerCase();
    } catch (err) {
      console.log('target:', candidate);
    }

    const inputArray = input.toLowerCase().split(' ');
    for (const rawSubInput of inputArray) {
      // Strip trailing slash for matching (e.g. "~/git/" → "~/git")
      const subInput = rawSubInput.endsWith('/') ? rawSubInput.slice(0, -1) : rawSubInput;
      if (!subInput) continue;
      // Expand ~ to home dir so "~/git/codev" matches "/Users/grimmer/git/codev"
      const home = getHomeDir();
      const expanded = subInput.startsWith('~/') && home
        ? (home + '/').toLowerCase() + subInput.slice(2)
        : subInput === '~' && home
          ? home.toLowerCase()
          : subInput;
      if (!target?.includes(expanded)) {
        return false;
      }
    }
    return true;
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
          padding: '8px 15px',
          borderBottom: '1px solid #333',
          backgroundColor: '#252525',
          // @ts-ignore — Electron-specific CSS property for frameless window dragging
          WebkitAppRegion: currentAppMode === 'normal' ? 'drag' : undefined,
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
          CodeV
          <span style={{ display: 'inline-flex', flexDirection: 'column', marginLeft: '8px', lineHeight: 1.2 }}>
            <span style={{ fontSize: '11px', color: '#888', fontWeight: 'normal' }}>Dev Hub</span>
            {currentAppMode && (
              <span style={{ fontSize: '9px', color: '#555', fontWeight: 'normal' }}>
                {currentAppMode === 'normal' ? 'normal mode' : 'menu bar mode'}
              </span>
            )}
          </span>
        </div>
        {/* @ts-ignore */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', WebkitAppRegion: 'no-drag' }}>
          {quickSwitcherShortcut && (
            <span
              onClick={() => setSettingsOpenToTab('shortcuts')}
              title="Click to customize shortcuts"
              style={{ fontSize: '10px', color: '#555', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#888'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#555'; }}
            >
              {quickSwitcherShortcut}
            </span>
          )}
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
            openToTab={settingsOpenToTab}
            onOpenToTabConsumed={() => setSettingsOpenToTab(null)}
            saveCallback={(key: string, value: string) => {
              if (key === 'sessionDisplayMode') {
                setSessionDisplayMode(value);
              }
            }}
          />
        </div>
      </div>

      {/* Terminal tab: always mounted, use visibility (not display) to preserve xterm layout and avoid re-fit flash (#99) */}
      <div style={{
        flex: mode === 'terminal' ? 1 : 0,
        overflow: 'hidden',
        visibility: mode === 'terminal' ? 'visible' : 'hidden',
        position: mode === 'terminal' ? 'relative' : 'absolute',
        width: mode === 'terminal' ? undefined : '100%',
        height: mode === 'terminal' ? undefined : '100%',
      }}>
        <TerminalTab
          visible={mode === 'terminal'}
          onLaunchExternal={async () => {
            const cwd = await window.electronAPI.terminalGetCwd();
            if (cwd) {
              window.electronAPI.launchNewClaudeSession(cwd);
            }
          }}
        />
      </div>

      {/* Mode change banner */}
      {modeBanner && (
        <div style={{
          padding: '6px 15px',
          backgroundColor: 'rgba(0, 188, 212, 0.1)',
          borderBottom: '1px solid rgba(0, 188, 212, 0.2)',
          fontSize: '11px',
          color: '#8ecfda',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{modeBanner}</span>
          <span
            style={{ cursor: 'pointer', color: '#666', marginLeft: '8px' }}
            onClick={() => setModeBanner(null)}
          >
            x
          </span>
        </div>
      )}

      {mode !== 'terminal' && (mode === 'sessions' ? (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 15px 0' }}>
            <input
              ref={sessionSearchRef}
              value={sessionSearchValue}
            onChange={(e) => {
              const val = e.target.value;
              setSessionSearchValue(val);
              sessionSearchRef2.current = val;
              scheduleDeepSearch(val);
              setSessions(applySearchFilter(allSessions, val));
              setSelectedSessionIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (sessionSearchValue) {
                  setSessionSearchValue('');
                  sessionSearchRef2.current = '';
                  scheduleDeepSearch('');
                  setSessions(allSessions);
                } else {
                  hideApp();
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSessionIndex((i) => {
                  const next = Math.min(i + 1, displayedSessions.length - 1);
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
                  const next = Math.min(i + 5, displayedSessions.length - 1);
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
                const s = displayedSessions[idx];
                if (s && !s.__liveOrphan) {
                  // Arm before opening, in case the bridge triggers the focus cycle synchronously.
                  clearSessionSearchOnShowRef.current = true;
                  window.electronAPI.openClaudeSession(s.sessionId, s.project, s.isActive, s.activePid, customTitles[s.sessionId]);
                }
              } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
                // ⌘D toggles pin, ⇧⌘D toggles hide on the selected row.
                // Requires an EXPLICIT selection (hover or arrow keys):
                // defaulting to row 0 — unlike Enter, which opens the top
                // result — made a bare ⌘D after a tab switch silently toggle
                // the first pinned-zone row (user-reported footgun).
                e.preventDefault();
                if (selectedSessionIndex < 0) return;
                const s = displayedSessions[selectedSessionIndex];
                // A process with no session id has nothing to pin or hide.
                if (s && !s.__liveOrphan) {
                  // ⇧⌘D on a zone row = unpin + fold (pin/hide are exclusive)
                  if (e.shiftKey) {
                    toggleHide(s);
                  } else {
                    togglePin(s);
                  }
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
            {/* Scope chips: live processes (issue #94) and saved lists
                (issue #145). Here, not in the list, because this row has
                spare width and the list has no spare height. */}
            <span
              role="button"
              tabIndex={0}
              aria-pressed={liveOnlyActive}
              title={
                liveOnlyActive
                  ? `Show every session again${liveReport ? ` · measured ${formatRelativeTime(liveReport.measuredAt)}; re-read on each open and on toggling` : ''}`
                  : `Show only sessions with a running process${staleCount ? ` · ${staleCount} stale registration${staleCount > 1 ? 's' : ''} in ~/.claude/sessions` : ''}`
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleLiveOnly}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleLiveOnly();
                }
              }}
              style={liveOnlyActive ? SCOPE_CHIP_ACTIVE_STYLE : SCOPE_CHIP_STYLE}
            >
              ● {liveCount} live{staleCount > 0 ? ` ⚠${staleCount}` : ''}
            </span>
            {liveOnlyActive && (
              <span
                role="button"
                tabIndex={0}
                aria-pressed={liveStats}
                title={
                  liveStats
                    ? 'Hide per-row memory and uptime'
                    : 'Show each running session’s memory and uptime (which one to close first)'
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setLiveStats((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setLiveStats((v) => !v);
                  }
                }}
                style={liveStats ? SCOPE_CHIP_ACTIVE_STYLE : SCOPE_CHIP_STYLE}
              >
                stats
              </span>
            )}
            {(liveOnlyActive || pinnedOnlyActive || isSearchingSessions) && !listViewActive && (
              <span
                role="button"
                tabIndex={0}
                title="Save the sessions shown as a named list"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  // The document-level click handler refocuses the search box
                  // (forceFocusOnInput); let the dialog's input keep focus.
                  e.stopPropagation();
                  openSaveListPrompt();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openSaveListPrompt();
                  }
                }}
                style={LISTS_CHIP_STYLE}
              >
                save list…
              </span>
            )}
            <span
              role="button"
              tabIndex={0}
              aria-pressed={listsExpanded}
              title={
                sessionLists.length === 0
                  ? 'No saved lists yet — scope the list (live / only / search) and click "save list…"'
                  : listsExpanded
                    ? 'Hide saved lists'
                    : 'Show saved lists'
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setListsExpanded((v) => !v);
                setConfirmDeleteListId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setListsExpanded((v) => !v);
                }
              }}
              style={listsExpanded && !listViewActive ? LISTS_CHIP_ACTIVE_STYLE : LISTS_CHIP_STYLE}
            >
              🗂 {sessionLists.length}
            </span>
            <span style={{ color: THEME.text.secondary, fontSize: '12px', whiteSpace: 'nowrap' }}>
              {/* Scoped modes must report what is on screen — an unscoped
                  count next to a filtered list reads as a bug. */}
              {listViewActive && viewingList
                ? `${displayedSessions.length} of ${viewingList.members.length} in list`
                : liveOnlyActive
                  ? // The chip already carries the live count; repeating it
                    // here read as a second, disagreeing number. Show the
                    // memory of what is listed, and a count only when a
                    // search has narrowed the list.
                    isSearchingSessions
                    ? `${displayedSessions.length} of ${liveCount} · ${formatMb(displayedRssKb)}`
                    : formatMb(displayedRssKb)
                  : `${pinnedOnlyActive ? displayedSessions.length : sessions.length} sessions`}
            </span>
          </div>
          {/* The store exists but cannot be trusted as written. Say so, with
              what it holds — never rewrite it from here (same policy as the
              marks store; a future format change gets a migration, not a
              repair button). */}
          {listsStoreProblem && (
            <div style={{ margin: '4px 15px 0', color: '#e0b060', fontSize: '11px' }}>
              {listsStoreProblem.parseable
                ? `⚠ ~/.config/codev/session-lists.json cannot be trusted as written (${listsStoreProblem.rawLists} list${listsStoreProblem.rawLists === 1 ? '' : 's'} / ${listsStoreProblem.rawMembers} session${listsStoreProblem.rawMembers === 1 ? '' : 's'} inside) — fix or remove it; saved lists are unavailable until then`
                : '⚠ ~/.config/codev/session-lists.json is not valid JSON — fix or remove it; saved lists are unavailable until then'}
            </div>
          )}
          {listsNotice && (
            <div style={{ margin: '4px 15px 0', color: '#e07a5f', fontSize: '11px' }}>
              ⚠ {listsNotice}
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 8px' }}>
            {/* A list being viewed: its header replaces every other zone. */}
            {listViewActive && viewingList && (
              <div style={LISTS_HEADER_STYLE}>
                <span title={`Saved ${new Date(viewingList.createdAt).toLocaleString()}`}>
                  🗂 {viewingList.name} ({viewingList.members.length}) · saved {formatRelativeTime(viewingList.createdAt)}
                  {' '}
                  <span
                    role="button"
                    tabIndex={0}
                    title="Rename this list"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openRenameListPrompt(viewingList.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openRenameListPrompt(viewingList.id);
                      }
                    }}
                    style={{ cursor: 'pointer', color: '#666', fontSize: '11px' }}
                  >
                    ✎
                  </span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  title="Back to every session"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={closeList}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      closeList();
                    }
                  }}
                  style={LISTS_CHIP_STYLE}
                >
                  ✕ close
                </span>
              </div>
            )}
            {/* Saved lists zone: one row per list; click to view it. Opens
                even when empty — a chip that does nothing reads as broken. */}
            {!listViewActive && listsExpanded && (
              <>
                <div style={LISTS_HEADER_STYLE}>
                  <span>🗂 Lists ({sessionLists.length})</span>
                </div>
                {sessionLists.length === 0 && (
                  <div style={{ ...LIST_ROW_STYLE, cursor: 'default', color: THEME.text.secondary }}>
                    No saved lists yet — turn on <span style={SCOPE_CHIP_STYLE}>● live</span>, <span style={PINNED_ONLY_CHIP_STYLE}>only</span> or type a search, then click <span style={LISTS_CHIP_STYLE}>save list…</span>
                  </div>
                )}
                {sessionLists.map((l) => (
                  // The clickable part is a real button with a name; the
                  // rename / delete controls are its SIBLINGS, so nothing is
                  // nested in a button and every control is reachable by
                  // keyboard and announced by a screen reader.
                  <div key={l.id} className="codev-list-row" style={LIST_ROW_STYLE}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`Open list ${l.name}, ${l.members.length} sessions`}
                      title={`${l.members.length} sessions · saved ${new Date(l.createdAt).toLocaleString()} · click or Enter to view`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => openList(l.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openList(l.id);
                        }
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, cursor: 'pointer' }}
                    >
                      <span style={{ color: '#9DC8E0', fontWeight: 500, flexShrink: 0 }}>{l.name}</span>
                      <span style={{ color: THEME.text.secondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.members.length} sessions · {formatRelativeTime(l.createdAt)}
                        {' · '}
                        {l.members.slice(0, 4).map((m) => m.title || m.projectName).join(' · ')}
                        {l.members.length > 4 ? ' …' : ''}
                      </span>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      title="Rename this list"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRenameListPrompt(l.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          openRenameListPrompt(l.id);
                        }
                      }}
                      style={{ cursor: 'pointer', fontSize: '11px', flexShrink: 0, color: '#666' }}
                    >
                      ✎
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      title={confirmDeleteListId === l.id ? 'Click again to delete this list' : 'Delete this list'}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirmDeleteListId === l.id) deleteList(l.id);
                        else setConfirmDeleteListId(l.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (confirmDeleteListId === l.id) deleteList(l.id);
                          else setConfirmDeleteListId(l.id);
                        }
                      }}
                      style={{
                        cursor: 'pointer',
                        fontSize: '11px',
                        flexShrink: 0,
                        color: confirmDeleteListId === l.id ? '#e07a5f' : '#666',
                      }}
                    >
                      {confirmDeleteListId === l.id ? 'delete?' : '✕'}
                    </span>
                  </div>
                ))}
                <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 2px 3px' }} />
              </>
            )}
            {pinnedRows.length > 0 && !liveOnlyActive && !listViewActive && (
              <div style={PINNED_HEADER_STYLE}>
                <span
                  role="button"
                  tabIndex={0}
                  title={
                    canGroupPins
                      ? 'Click to group pins at the top / leave them in time order · ⌘D pin/unpin · ⇧⌘D hide'
                      : 'Grouping applies while browsing every session'
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={canGroupPins ? togglePinnedCollapsed : undefined}
                  onKeyDown={(e) => {
                    if (
                      canGroupPins &&
                      (e.key === 'Enter' || e.key === ' ')
                    ) {
                      e.preventDefault();
                      togglePinnedCollapsed();
                    }
                  }}
                  style={{ cursor: canGroupPins ? 'pointer' : 'default' }}
                >
                  {canGroupPins ? (pinnedCollapsed ? '▸ ' : '▾ ') : ''}📌 Pinned ({pinnedRows.length})
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-pressed={pinnedOnlyActive}
                  title={
                    pinnedOnlyActive
                      ? 'Show every session again'
                      : 'Show — and search — pinned sessions only'
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={togglePinnedOnly}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      togglePinnedOnly();
                    }
                  }}
                  style={
                    pinnedOnlyActive
                      ? PINNED_ONLY_CHIP_ACTIVE_STYLE
                      : PINNED_ONLY_CHIP_STYLE
                  }
                >
                  only
                </span>
              </div>
            )}
            {displayedSessions.length === 0 && minorSessions.length === 0 ? (
              <div style={{ color: THEME.text.secondary, textAlign: 'center', padding: '20px 0' }}>
                {listViewActive
                  ? sessionSearchValue
                    ? '⚠️ No session in this list matches'
                    : '🗂 This list is empty'
                  : liveOnlyActive
                    ? liveReport
                      ? sessionSearchValue
                        ? '⚠️ No running session matches'
                        : '● No running Claude Code session'
                      : '● Looking for running sessions…'
                    : pinnedOnlyActive
                      ? '⚠️ No pinned session matches — click "only" above to leave pinned-only'
                      : sessionSearchValue
                        ? '⚠️ No matching sessions found'
                        : '🤖 No Claude Code sessions found'}
              </div>
            ) : (<>
              {displayedSessions.map((session, index) => (
                // A synthetic live row is keyed by pid: two processes can
                // share one sessionId (a resumed copy, a /branch parent and
                // child), and duplicate keys leave stale rows on screen.
                <Fragment key={`${session.__pinnedRow ? 'pin:' : ''}${session.__live ? `live:${session.__live.pid}:` : ''}${session.sessionId}`}>
                {visiblePinnedRows.length > 0 && index === visiblePinnedRows.length && (
                  <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 2px 3px' }} />
                )}
                {minorsExpanded &&
                  minorSessions.length > 0 &&
                  index === minorFoldHeaderIndex && (
                  <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setMinorsExpanded(false); setSelectedSessionIndex(0); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setMinorsExpanded(false);
                        setSelectedSessionIndex(0);
                      }
                    }}
                    style={MINOR_FOLD_HEADER_STYLE}
                  >
                    ▾ {minorSessions.length} minor sessions {minorFoldSuffix}
                  </div>
                )}
                <div
                  data-session-index={index}
                  onClick={() => {
                    // A running process with no session id has nothing to resume.
                    if (session.__liveOrphan) return;
                    clearSessionSearchOnShowRef.current = true;
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
                        : status === 'needs-attention' ? '#F06856'
                        : '#CE93D8'; // no status data yet
                      const animation = status === 'working' ? 'statusPulse 2.5s ease-in-out infinite'
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
                        {sessionMarks.pins[session.sessionId] && (
                          <span style={{ color: '#f5b942', fontSize: '12px', marginRight: '3px' }}>★</span>
                        )}
                        {hiddenSet.has(session.sessionId) && (
                          <span title="Hidden session" style={{ color: '#e07a5f', fontSize: '11px', marginRight: '3px' }}>⊘</span>
                        )}
                        <span style={{ fontWeight: '500', fontSize: '15px', color: THEME.text.primary }}>
                          <Highlighter
                            searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                            autoEscape
                            textToHighlight={session.projectName}
                            highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                          />
                        </span>
                        {/* Title and branch fall back to what a saved list
                            captured, so a member whose transcript is gone
                            still reads as the session it was. */}
                        {(customTitles[session.sessionId] || session.__listMember?.title) && (
                          <span
                            title={customTitles[session.sessionId] || session.__listMember?.title}
                            style={{
                              color: '#7ec87e',
                              fontSize: '13px',
                              fontWeight: '500',
                            }}
                          >
                            {' '}* <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={fitToRow(
                                customTitles[session.sessionId] || session.__listMember?.title || '',
                                60,
                              )}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                        {(branches[session.sessionId] || session.__listMember?.branch) && (
                          <span style={{ color: '#888', fontSize: '11px', fontStyle: 'italic' }}>
                            {' '}[<Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={fitToRow(
                                branches[session.sessionId] || session.__listMember?.branch || '',
                                40,
                              )}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />]
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, marginLeft: '10px' }}>
                        {index === selectedSessionIndex && !session.__liveOrphan && (
                          <>
                            <span
                              title={sessionMarks.pins[session.sessionId] ? 'Unpin (⌘D)' : 'Pin (⌘D)'}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => { e.stopPropagation(); togglePin(session); }}
                              style={{ cursor: 'pointer', fontSize: '11px', color: sessionMarks.pins[session.sessionId] ? '#f5b942' : '#777' }}
                            >
                              📌
                            </span>
                            <span
                              title={hiddenSet.has(session.sessionId) ? 'Unhide' : session.__pinnedRow ? 'Unpin & hide into minor sessions (⇧⌘D)' : 'Hide into minor sessions (⇧⌘D)'}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => { e.stopPropagation(); toggleHide(session); }}
                              style={{ cursor: 'pointer', fontSize: '11px', color: hiddenSet.has(session.sessionId) ? '#e07a5f' : '#666' }}
                            >
                              ⊘
                            </span>
                          </>
                        )}
                        {/* Process facts, live scope only: memory · uptime · tty,
                            and a warning when the process is running but not
                            registered — the case that hides from every other view. */}
                        {(() => {
                          if (!liveOnlyActive) return null;
                          // A synthetic row carries its own process; a real
                          // row looks its process up by id. Own facts first,
                          // or two processes on one id would show one set.
                          const live = session.__live || liveBySession[session.sessionId];
                          if (!live) return null;
                          // Figures only behind the `stats` toggle; the
                          // warning below is not a figure and always shows.
                          // The tty is for the app (window switching, #142)
                          // and the tooltip — on the row it was width spent
                          // on something a person cannot act on.
                          return (
                            <>
                              {liveStats && (
                                <span
                                  style={LIVE_INFO_STYLE}
                                  title={`pid ${live.pid}${live.tty ? ` on ${live.tty}` : ' (no terminal)'} · resident memory · time since the process started`}
                                >
                                  {formatMb(live.rssKb)} · {formatUptime(live.uptimeSec)}
                                </span>
                              )}
                              {!live.registered && (
                                <span
                                  style={LIVE_WARN_STYLE}
                                  title="Running, but not registered in ~/.claude/sessions — invisible to the usual active-session detection"
                                >
                                  ⚠ unregistered
                                </span>
                              )}
                              {session.__liveExtra && (
                                <span
                                  style={LIVE_WARN_STYLE}
                                  title={`A second process is running this same session (pid ${live.pid}) — a resumed copy, or a /branch parent and child`}
                                >
                                  ⚠ 2nd process
                                </span>
                              )}
                            </>
                          );
                        })()}
                        {/* The id is searchable but never otherwise on screen,
                            so a hit on it gets its own marker (the same rule
                            as the `match #N` line — show what the row matched
                            on when the match is not already visible). */}
                        {isSearchingSessions &&
                          !session.__liveOrphan &&
                          searchWordsLower.some((w) => matchesSessionId(session.sessionId, w)) && (
                            <span
                              style={{
                                fontSize: '10px',
                                color: '#1a1a1a',
                                backgroundColor: SEARCH_HIGHLIGHT_STYLE.backgroundColor,
                                borderRadius: '3px',
                                padding: '1px 5px',
                                fontFamily: 'Menlo, monospace',
                              }}
                              title={session.sessionId}
                            >
                              id {session.sessionId.slice(0, 8)}
                            </span>
                          )}
                        {prLinks[session.sessionId] && (() => {
                          const prInfo = prLinks[session.sessionId];
                          const searchWords = sessionSearchValue.split(/\s+/).filter(Boolean);
                          // Highlight badge when search matches PR URL (not just badge text)
                          const urlMatch = searchWords.length > 0 && searchWords.some((w: string) =>
                            prInfo.prUrl.toLowerCase().includes(w.toLowerCase()));
                          return (
                            <span
                              style={{
                                fontSize: '10px',
                                color: urlMatch ? '#b0e0f0' : '#7ec8e3',
                                border: `1px solid ${urlMatch ? '#7ec8e3' : '#4a8a9e'}`,
                                borderRadius: '3px',
                                padding: '1px 5px',
                                cursor: 'pointer',
                                backgroundColor: urlMatch ? 'rgba(126, 200, 227, 0.2)' : 'transparent',
                              }}
                              title={prInfo.prUrl}
                              onClick={(e) => {
                                e.stopPropagation();
                                window.electronAPI.openExternal(prInfo.prUrl);
                              }}
                            >
                              <Highlighter
                                searchWords={searchWords}
                                textToHighlight={`PR #${prInfo.prNumber}`}
                                highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                              />
                            </span>
                          );
                        })()}
                        {session.accountLabel && !session.accountIsAnchor && (
                          <span
                            style={{
                              fontSize: '9px',
                              color: '#c9a0e8',
                              border: '1px solid #7a5a9e',
                              borderRadius: '3px',
                              padding: '1px 4px',
                              textTransform: 'uppercase',
                            }}
                            title={`Claude account: ${session.accountLabel}`}
                          >
                            {session.accountLabel}
                          </span>
                        )}
                        {(() => {
                          // Only show terminal/IDE badge for active sessions
                          const badge = session.isActive
                            ? (terminalApps[session.sessionId] && terminalApps[session.sessionId] !== 'unknown' ? terminalApps[session.sessionId] : null)
                            : null;
                          return badge ? (
                            <span style={{
                              fontSize: '9px',
                              color: '#aaa',
                              border: '1px solid #555',
                              borderRadius: '3px',
                              padding: '1px 4px',
                              textTransform: 'uppercase',
                            }}>
                              <Highlighter
                                searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                                textToHighlight={badge}
                                highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                              />
                            </span>
                          ) : null;
                        })()}
                        <span style={{ color: THEME.text.secondary, fontSize: '12px' }}>
                          {session.messageCount ?? '…'} msgs
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
                              autoEscape
                              textToHighlight={fitToRow(
                                session.firstUserMessage || '',
                                sessionDisplayMode === 'both' ? 50 : 80,
                              )}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                        {sessionDisplayMode === 'last' && session.lastUserMessage && (
                          <span style={{ color: '#c89030', fontSize: '12px' }}>
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={fitToRow(
                                session.lastUserMessage || '',
                                80,
                              )}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                        {sessionDisplayMode === 'both' && session.lastUserMessage && session.lastUserMessage !== session.firstUserMessage && (
                          <span style={{ color: '#c89030', fontSize: '12px' }}>
                            {'  →  '}
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={fitToRow(
                                session.lastUserMessage || '',
                                40,
                              )}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                      </div>
                    )}
                    {/* Matched-prompt snippet (main-side deep search) — shown when the
                        match isn't already visible in the first/last lines above */}
                    {(() => {
                      const m = searchSnippets[session.sessionId];
                      if (!m || !isSearchingSessions) return null;
                      const words = sessionSearchValue.split(/\s+/).filter(Boolean);
                      // Stale guard: snippet must still match the current query
                      if (!words.some((w) => m.snippet.toLowerCase().includes(w.toLowerCase()))) return null;
                      const dupFirst = m.promptIndex === 0 && (sessionDisplayMode === 'first' || sessionDisplayMode === 'both');
                      const dupLast = m.isLastPrompt && (sessionDisplayMode === 'last' || sessionDisplayMode === 'both');
                      if (dupFirst || dupLast) return null;
                      return (
                        <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '1px' }}>
                          <span style={SNIPPET_LINE_STYLE}>
                            <span style={SNIPPET_MARKER_STYLE}>
                              match #{m.promptIndex + 1}
                            </span>{' '}
                            <Highlighter
                              searchWords={words}
                              autoEscape
                              textToHighlight={m.snippet.slice(0, 120)}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        </div>
                      );
                    })()}
                    {/* Line 3: on a saved-list member, the recap captured
                        with it — Claude Code's own "where we are, what's
                        next" line, which is what a snapshot is for. Otherwise
                        the last assistant response. One line either way. */}
                    {(() => {
                      const captured = session.__listMember;
                      const recap = captured?.recap;
                      if (recap) {
                        // A recap never repeats back-to-back, so it can predate
                        // the session's last turn by a lot; say so when it does,
                        // because its last sentence is usually "next: …".
                        const writtenAt = recap.at ? new Date(recap.at).getTime() : 0;
                        const lagMs = writtenAt ? (captured.lastTimestamp || 0) - writtenAt : 0;
                        const stale = lagMs > 30 * 60 * 1000;
                        return (
                          <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '1px' }}>
                            <span style={{ color: '#9DC8E0', fontSize: '11px' }}>
                              <span
                                style={RECAP_MARKER_STYLE}
                                title={
                                  writtenAt
                                    ? `Recap written ${formatRelativeTime(writtenAt)}${stale ? ` — ${formatUptime(lagMs / 1000)} before the session's last activity, so its "next step" may be done` : ''}`
                                    : 'Recap (time unknown)'
                                }
                              >
                                recap{stale ? ' ⏱' : ''}
                              </span>{' '}
                              <Highlighter
                                searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                                autoEscape
                                textToHighlight={fitToRow(recap.text, 110)}
                                highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                              />
                            </span>
                          </div>
                        );
                      }
                      const reply = assistantResponses[session.sessionId] || captured?.lastAssistantMessage;
                      if (!reply) return null;
                      return (
                        <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '1px' }}>
                          <span style={{ color: '#9DC8E0', fontSize: '11px' }}>
                            ◀ <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={fitToRow(reply, 80)}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                </div>
                </Fragment>
              ))}
              {!isSearchingSessions && !minorsExpanded && minorSessions.length > 0 && (
                <div
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMinorsExpanded(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setMinorsExpanded(true);
                    }
                  }}
                  style={{ padding: '6px 10px 8px 24px', color: '#777', fontSize: '12px', cursor: 'pointer' }}
                >
                  ▸ {minorSessions.length} minor sessions {minorFoldSuffix}
                </div>
              )}
            </>)}
          </div>
          {/* Always-visible fold bar (outside the scroll area) while minors
              are expanded — collapsing never depends on scroll position. */}
          {!isSearchingSessions && minorsExpanded && minorSessions.length > 0 && (
            <div
              role="button"
              tabIndex={0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setMinorsExpanded(false); setSelectedSessionIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMinorsExpanded(false);
                  setSelectedSessionIndex(0);
                }
              }}
              style={MINOR_FOLD_BAR_STYLE}
            >
              ▾ {minorSessions.length} minor sessions shown — click to fold
            </div>
          )}
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
          // Cmd+Enter or Shift+Enter: launch new Claude session
          // Set flag so onChange knows to launch instead of opening IDE
          // Clear on every keypress to prevent stale ref if onChange didn't fire
          launchClaudeRef.current = null;
          if (evt.key === 'Enter' && (evt.metaKey || evt.shiftKey)) {
            // ⌥⌘+Enter: choose the account first (multi-account, 2c-lite)
            launchClaudeRef.current =
              evt.metaKey && evt.altKey
                ? 'external-pick'
                : evt.shiftKey
                  ? 'codev'
                  : 'external';
          }
        }}
        onInputChange={(evt) => {
          setInputValue(evt);
        }}
        onChange={(evt: any) => {
          const launchMode = launchClaudeRef.current;
          launchClaudeRef.current = null;
          if (launchMode === 'codev') {
            window.electronAPI.launchNewClaudeSessionInCodev(evt.value);
          } else if (launchMode === 'external-pick') {
            openAccountPickerForLaunch(evt.value);
          } else if (launchMode === 'external') {
            window.electronAPI.launchNewClaudeSession(evt.value);
          } else {
            invokeVSCode(evt.value, optionPress.current);
          }
          /** in this case, when invokeVSCode triggers this ui to be hided,
           * there will no keyup event triggered to reset optionPress.current,
           * so we reset here */
          optionPress.current = false;
        }}
        // Custom components
        components={{
          // Hide react-select's default vertical separator ("|" that looks
          // like a stray cursor before the hint text).
          IndicatorSeparator: () => null,
          DropdownIndicator: () => (
            <div
              title="\u2325\u2318+Enter: choose the account first"
              style={{ fontSize: '11px', color: '#666', paddingRight: '8px', whiteSpace: 'nowrap' }}
            >
              {isMultiAccountUI
                ? '\u2318+Enter: New Claude \u00b7 \u2325\u2318+Enter: pick account'
                : '\u2318+Enter: New Claude'}
            </div>
          ),
          Option: (props) => OptionUI(props, onDeleteClick, (path: string) => {
            window.electronAPI.launchNewClaudeSession(path);
          }),
        }}
        formatOptionLabel={(
          { value, label, everOpened }: { value: string; label: string; everOpened: boolean },
          { inputValue: searchInput }: { inputValue: string },
        ) => {
          const home = getHomeDir();
          const homePrefix = home ? home + '/' : '';
          // Normalize search words: replace home dir prefix with ~/, strip trailing /
          const searchWords = (searchInput ?? '')
            .split(' ')
            .filter((sub: string) => sub)
            .map((w: string) => home && w === home ? '~' : homePrefix && w.startsWith(homePrefix) ? '~/' + w.slice(homePrefix.length) : w)
            .map((w: string) => w.endsWith('/') ? w.slice(0, -1) : w)
            .filter((w: string) => w);
          // Split path tokens into individual segments for highlighting both name and path columns.
          // E.g. "~/git/fred-ff-test-token" → ['~', 'git', 'fred-ff-test-token', '~/git/fred-ff-test-token']
          // Both Highlighters get all segments, so each column highlights whatever matches.
          const allSegments = searchWords.flatMap((w: string) =>
            w.includes('/') ? [...w.split('/').filter(Boolean), w] : [w]
          );
          // Deduplicate
          const highlightWords = [...new Set(allSegments)];
          const pathPart = shortenPath(label?.slice(0, label.lastIndexOf('/')));
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
                  searchWords={highlightWords}
                  autoEscape
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
                    autoEscape
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
                  searchWords={highlightWords}
                  autoEscape
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
      {launchPicker && (
        <div
          data-settings-panel
          onClick={() => setLaunchPicker(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                setLaunchPicker(null);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setLaunchPickerIndex((i) => (i + 1) % launchPicker.accounts.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setLaunchPickerIndex(
                  (i) => (i - 1 + launchPicker.accounts.length) % launchPicker.accounts.length,
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pickLaunchAccount(launchPicker.accounts[launchPickerIndex]);
              }
            }}
            tabIndex={0}
            ref={(el) => el?.focus()}
            style={{
              marginTop: '120px',
              minWidth: '320px',
              background: '#252526',
              border: '1px solid #454545',
              borderRadius: '8px',
              padding: '8px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
              outline: 'none',
            }}
          >
            <div style={{ fontSize: '11px', color: '#888', padding: '2px 8px 6px' }}>
              New Claude in {launchPicker.path.split('/').pop()} as… (↑↓ · Enter · Esc)
            </div>
            {launchPicker.accounts.map((a, i) => (
              <div
                key={a.label}
                onClick={() => pickLaunchAccount(a)}
                onMouseEnter={() => setLaunchPickerIndex(i)}
                style={{
                  padding: '6px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: i === launchPickerIndex ? '#094771' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <span style={{ color: '#e9e9e9', fontSize: '13px' }}>
                  {a.label}
                  {a.isCurrentDefault && (
                    <span style={{ color: '#00BCD4', fontSize: '10px', marginLeft: '6px' }}>
                      default
                    </span>
                  )}
                </span>
                <span style={{ color: '#888', fontSize: '11px' }}>
                  {a.loggedIn ? a.email || '' : 'not logged in'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
      ))}
      {/* Save-list dialog. Top level, outside the mode branches: it is opened
          from the Sessions tab, and a modal nested inside the Projects branch
          never renders there (the first live test found exactly that). */}
      {saveListPrompt && (
        <div
          data-settings-panel
          onClick={closeSaveListPrompt}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                closeSaveListPrompt();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                saveList();
              }
            }}
            style={{
              marginTop: '120px',
              minWidth: '360px',
              background: '#252526',
              border: '1px solid #454545',
              borderRadius: '8px',
              padding: '10px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            }}
          >
            <div style={{ fontSize: '11px', color: '#888', padding: '2px 4px 8px' }}>
              {saveListPrompt.renameId
                ? `Rename this list (${saveListPrompt.count} session${saveListPrompt.count === 1 ? '' : 's'}) — Enter · Esc`
                : `Save ${saveListPrompt.count} session${saveListPrompt.count === 1 ? '' : 's'} as a list (Enter · Esc)`}
            </div>
            <input
              autoFocus
              value={saveListPrompt.name}
              onChange={(e) => setSaveListPrompt({ ...saveListPrompt, name: e.target.value })}
              onFocus={(e) => e.target.select()}
              placeholder={
                saveListPrompt.renameId
                  ? sessionLists.find((l) => l.id === saveListPrompt.renameId)?.name
                  : nextListName(sessionLists.map((l) => l.name))
              }
              style={{
                width: '100%',
                boxSizing: 'border-box',
                backgroundColor: '#2d2d2d',
                border: '1px solid #444',
                borderRadius: '4px',
                padding: '8px 10px',
                color: THEME.text.primary,
                fontSize: '13px',
                outline: 'none',
              }}
            />
          </div>
        </div>
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
