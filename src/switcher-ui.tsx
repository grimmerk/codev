import { VSWindow as VSWindowModel } from '@prisma/client';
import { FC, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import Highlighter from 'react-highlight-words';
import Select, { components, OptionProps } from 'react-select';
import { HoverButton } from './HoverButton';
import PopupDefaultExample from './popup';
import { isMinorSession } from './session-search';
import TerminalTab from './terminal-tab';

type SwitcherMode = 'projects' | 'sessions' | 'terminal';
// import { fetchVSCodeBasedOpenedWindows, SERVER_URL, deleteRecentProjectRecord } from "./vscode-based-ide-utility"
export const SERVER_URL = 'http://localhost:55688';

// Unified search-match highlight — high contrast on every row color scheme
// (the previous per-site translucent styles were near-invisible on colored text).
const SEARCH_HIGHLIGHT_STYLE = {
  backgroundColor: '#f5b942',
  color: '#1a1a1a',
  padding: '0 2px',
  borderRadius: '2px',
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

// Header row of the pinned zone at the top of the Sessions list.
const PINNED_HEADER_STYLE = {
  padding: '6px 10px 2px 24px',
  color: '#c9a227',
  fontSize: '12px',
  cursor: 'pointer',
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
  const [pinnedCollapsed, setPinnedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('codev-pinned-collapsed') === '1';
    } catch {
      return false;
    }
  });
  // Pinned sessions living outside the loaded list (fetched by id)
  const [extraPinnedSessions, setExtraPinnedSessions] = useState<any[]>([]);
  const extraPinnedKeyRef = useRef('');
  // Keep the selection on the same session after pin/hide reshuffles the list
  const reanchorSelectionRef = useRef<string | null>(null);
  const modeRef = useRef<SwitcherMode>(initialMode);
  const activeStateRef = useRef<Record<string, number>>({});
  const allSessionsRef = useRef<any[]>([]);
  const lastAssistantFetchRef = useRef<Record<string, number>>({});
  const sessionSearchRef2 = useRef(''); // tracks current search value for use in closures
  const deepSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepSearchSeqRef = useRef(0);
  const deepMatchesRef = useRef<any[]>([]); // latest main-side full-prompt matches
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
      const searchTarget = `${s.projectName} ${s.project} ${s.firstUserMessage} ${s.lastUserMessage} ${customTitles[s.sessionId] || ''} ${branches[s.sessionId] || ''} ${prInfo ? `PR #${prInfo.prNumber} ${prInfo.prUrl}` : ''} ${assistantResponses[s.sessionId] || ''} ${terminalBadge}`.toLowerCase();
      return words.every((w: string) => searchTarget.includes(w));
    });
  };

  // Union of the local field filter and the latest main-side full-prompt search
  // results (issue #131). Deep matches outside the loaded list are appended,
  // then everything re-sorts into the usual recency order.
  const applySearchFilter = (allItems: any[], query: string) => {
    const base = filterSessionsLocally(allItems, query);
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
      setSessions(applySearchFilter(allSessionsRef.current, query));
      // Lazy-enrich deep matches that aren't in the loaded list. Bounded by
      // the deep-search result cap (100), same magnitude as the initial load.
      const loaded = new Set(
        allSessionsRef.current.map((s: any) => s.sessionId),
      );
      const appended = deepMatchesRef.current.filter(
        (s: any) => !loaded.has(s.sessionId),
      );
      if (appended.length > 0) {
        window.electronAPI.loadSessionEnrichment(appended).then((enrichment) => {
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
        window.electronAPI.loadLastAssistantResponses(appended).then((responses: Record<string, string>) => {
          if (responses && Object.keys(responses).length > 0) {
            setAssistantResponses((prev: Record<string, string>) => ({ ...prev, ...responses }));
          }
        });
      }
    }, 180);
  };

  // C1: fold minor (junk) sessions while browsing; searching shows everything.
  // Minors keep their recency order but render below the fold row at the end.
  // A user-hidden session is forced into the fold regardless of its stats.
  const isSearchingSessions = sessionSearchValue.trim().length > 0;
  const hiddenSet = new Set(sessionMarks.hidden);
  const majorSessions: any[] = [];
  const minorSessions: any[] = [];
  for (const s of sessions) {
    const minor =
      !isSearchingSessions &&
      (hiddenSet.has(s.sessionId) ||
        (activeDetectionReady &&
          isMinorSession(s, !!customTitles[s.sessionId], !!prLinks[s.sessionId])));
    (minor ? minorSessions : majorSessions).push(s);
  }
  // Manually hidden sessions may be titled/long — keep the fold label honest.
  const hiddenMinorCount = minorSessions.filter((s: any) =>
    hiddenSet.has(s.sessionId),
  ).length;
  const minorFoldSuffix =
    hiddenMinorCount > 0
      ? `(≤2 msgs, untitled · ${hiddenMinorCount} hidden)`
      : '(≤2 msgs, untitled)';

  // Pinned zone (PR-2): rows come from the loaded list when available, else
  // from the by-id fetch; ordered by pinnedAt (newest first). A pinned session
  // ALSO keeps its chronological spot below — the zone is a shortcut, not a move.
  const pinnedById = new Map<string, any>();
  for (const s of allSessions) {
    if (sessionMarks.pins[s.sessionId]) pinnedById.set(s.sessionId, s);
  }
  for (const s of extraPinnedSessions) {
    if (sessionMarks.pins[s.sessionId] && !pinnedById.has(s.sessionId)) {
      pinnedById.set(s.sessionId, s);
    }
  }
  const pinnedRows = Object.entries(sessionMarks.pins)
    .sort(([, a], [, b]) => (b.pinnedAt || '').localeCompare(a.pinnedAt || ''))
    .map(([id, info]) => {
      // Fall back to a placeholder built from the pin record itself: a pin
      // can be momentarily (VS Code sessions are absent from history.jsonl
      // until the closed-scan merges them in) or permanently unresolvable —
      // without this the zone count flaps on every tab switch.
      const s = pinnedById.get(id) ?? {
        sessionId: id,
        project: info.cwd || '',
        projectName:
          (info.cwd || '').split('/').filter(Boolean).pop() || id.slice(0, 8),
        firstUserMessage: '',
        lastUserMessage: '',
        lastTimestamp: 0,
        messageCount: 0,
        isActive: false,
        accountLabel: info.accountLabel,
      };
      return {
        ...s,
        __pinnedRow: true,
        isActive: s.sessionId in activeStateRef.current || s.isActive,
        activePid: activeStateRef.current[s.sessionId] ?? s.activePid,
      };
    });
  const showPinnedZone = !isSearchingSessions && pinnedRows.length > 0;
  const visiblePinnedRows = showPinnedZone && !pinnedCollapsed ? pinnedRows : [];

  const displayedSessions = [
    ...visiblePinnedRows,
    ...(minorsExpanded ? [...majorSessions, ...minorSessions] : majorSessions),
  ];

  // Arm the re-anchor together with the marks update (same commit): arming at
  // toggle-call time let any unrelated render consume the ref before the list
  // actually reshuffled, leaving the selection on the wrong row again.
  const applyMarksResult = (r: any, reanchorSessionId?: string) => {
    if (r?.ok && r.marks) {
      if (reanchorSessionId) reanchorSelectionRef.current = reanchorSessionId;
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
  const togglePinnedCollapsed = () => {
    setPinnedCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('codev-pinned-collapsed', next ? '1' : '0');
      } catch {}
      return next;
    });
    // The list just changed length — snap the selection back to the top,
    // same as the minors fold collapse does.
    setSelectedSessionIndex(0);
  };

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
        if (m) setSessionMarks({ pins: m.pins || {}, hidden: m.hidden || [] });
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.onSessionMarksUpdated(
      (_event: any, m: any) => {
        if (m) setSessionMarks({ pins: m.pins || {}, hidden: m.hidden || [] });
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
      setExtraPinnedSessions([]);
      return;
    }
    window.electronAPI.getSessionsByIds(missing).then((result: any[]) => {
      // Drop stale responses (a newer pin set superseded this request)
      if (extraPinnedKeyRef.current !== key) return;
      const found = result || [];
      setExtraPinnedSessions(found);
      if (found.length === 0) return;
      window.electronAPI.loadSessionEnrichment(found).then((enrichment) => {
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
          window.electronAPI.loadSessionEnrichment(allVSCode).then((enrichment) => {
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
      });
    });

    // Step 4: Load custom titles + branches in background
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
              return search.trim() ? filterSessionsLocally(updated, search) : updated;
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
                if (s) {
                  // Arm before opening, in case the bridge triggers the focus cycle synchronously.
                  clearSessionSearchOnShowRef.current = true;
                  window.electronAPI.openClaudeSession(s.sessionId, s.project, s.isActive, s.activePid, customTitles[s.sessionId]);
                }
              } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
                // ⌘D toggles pin, ⇧⌘D toggles hide on the selected row
                e.preventDefault();
                const idx = selectedSessionIndex >= 0 ? selectedSessionIndex : 0;
                const s = displayedSessions[idx];
                if (s) {
                  // Match the mouse UI: pinned-zone rows expose no hide control
                  if (e.shiftKey) {
                    if (!s.__pinnedRow) toggleHide(s);
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
            <span style={{ color: THEME.text.secondary, fontSize: '12px', whiteSpace: 'nowrap' }}>
              {sessions.length} sessions
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 8px' }}>
            {sessions.length === 0 ? (
              <div style={{ color: THEME.text.secondary, textAlign: 'center', padding: '20px 0' }}>
                {sessionSearchValue ? '⚠️ No matching sessions found' : '🤖 No Claude Code sessions found'}
              </div>
            ) : (<>
              {showPinnedZone && (
                <div
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={togglePinnedCollapsed}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      togglePinnedCollapsed();
                    }
                  }}
                  style={PINNED_HEADER_STYLE}
                >
                  {pinnedCollapsed ? '▸' : '▾'} 📌 Pinned ({pinnedRows.length})
                </div>
              )}
              {displayedSessions.map((session, index) => (
                <Fragment key={`${session.__pinnedRow ? 'pin:' : ''}${session.sessionId}`}>
                {visiblePinnedRows.length > 0 && index === visiblePinnedRows.length && (
                  <div style={{ borderTop: '1px solid #2a2a2a', margin: '4px 2px 3px' }} />
                )}
                {minorsExpanded && minorSessions.length > 0 && index === visiblePinnedRows.length + majorSessions.length && (
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
                        {customTitles[session.sessionId] && (
                          <span style={{ color: '#7ec87e', fontSize: '13px', fontWeight: '500' }}>
                            {' '}* <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={customTitles[session.sessionId].slice(0, 35)}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                        {branches[session.sessionId] && (
                          <span style={{ color: '#888', fontSize: '11px', fontStyle: 'italic' }}>
                            {' '}[<Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={branches[session.sessionId]}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />]
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, marginLeft: '10px' }}>
                        {index === selectedSessionIndex && (
                          <>
                            <span
                              title={sessionMarks.pins[session.sessionId] ? 'Unpin (⌘D)' : 'Pin (⌘D)'}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => { e.stopPropagation(); togglePin(session); }}
                              style={{ cursor: 'pointer', fontSize: '11px', color: sessionMarks.pins[session.sessionId] ? '#f5b942' : '#777' }}
                            >
                              📌
                            </span>
                            {!session.__pinnedRow && (
                              <span
                                title={hiddenSet.has(session.sessionId) ? 'Unhide' : 'Hide into minor sessions (⇧⌘D)'}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => { e.stopPropagation(); toggleHide(session); }}
                                style={{ cursor: 'pointer', fontSize: '11px', color: hiddenSet.has(session.sessionId) ? '#e07a5f' : '#666' }}
                              >
                                ⊘
                              </span>
                            )}
                          </>
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
                              autoEscape
                              textToHighlight={(session.firstUserMessage || '').slice(0, sessionDisplayMode === 'both' ? 50 : 80)}
                              highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                            />
                          </span>
                        )}
                        {sessionDisplayMode === 'last' && session.lastUserMessage && (
                          <span style={{ color: '#c89030', fontSize: '12px' }}>
                            <Highlighter
                              searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                              autoEscape
                              textToHighlight={(session.lastUserMessage || '').slice(0, 80)}
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
                              textToHighlight={(session.lastUserMessage || '').slice(0, 40)}
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
                          <span style={{ color: '#999', fontSize: '11px' }}>
                            ⌕ #{m.promptIndex + 1}{' '}
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
                    {/* Line 3: Last assistant response */}
                    {assistantResponses[session.sessionId] && (
                      <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: '1px' }}>
                        <span style={{ color: '#9DC8E0', fontSize: '11px' }}>
                          ◀ <Highlighter
                            searchWords={sessionSearchValue.split(/\s+/).filter(Boolean)}
                            autoEscape
                            textToHighlight={assistantResponses[session.sessionId].slice(0, 80)}
                            highlightStyle={SEARCH_HIGHLIGHT_STYLE}
                          />
                        </span>
                      </div>
                    )}
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
