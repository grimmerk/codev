import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';

const SEARCH_DECORATIONS = {
  matchBackground: '#515C6A',
  matchBorder: '#515C6A',
  matchOverviewRuler: '#d186167e',
  activeMatchBackground: '#A8AC94',
  activeMatchBorder: '#A8AC94',
  activeMatchColorOverviewRuler: '#A8AC94',
};

const searchButtonStyle: React.CSSProperties = {
  width: '20px',
  height: '20px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: '2px',
  color: '#cccccc',
  fontSize: '12px',
  cursor: 'pointer',
  padding: 0,
  lineHeight: 1,
};

const TerminalTab = ({ visible, onLaunchExternal }: { visible: boolean; onLaunchExternal?: () => void }) => {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const spawnedRef = useRef(false);
  const initializedRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations();
    xtermRef.current?.focus();
  }, []);

  const findNext = useCallback((query: string) => {
    if (!searchAddonRef.current) return;
    if (!query) {
      searchAddonRef.current.clearDecorations();
      setSearchResult(null);
      return;
    }
    searchAddonRef.current.findNext(query, {
      decorations: SEARCH_DECORATIONS,
    });
  }, []);

  const findPrevious = useCallback((query: string) => {
    if (!searchAddonRef.current || !query) return;
    searchAddonRef.current.findPrevious(query, {
      decorations: SEARCH_DECORATIONS,
    });
  }, []);

  // Initialize xterm once when first visible
  useEffect(() => {
    if (!visible || !termRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"Meslo LG S for Powerline", "MesloLGS NF", "Hack Nerd Font", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#e9e9e9',
        cursor: '#C0C0C0',
        selectionBackground: 'rgba(0, 188, 212, 0.3)',
      },
      cursorBlink: false,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(termRef.current);

    searchAddon.onDidChangeResults((result) => {
      setSearchResult(result);
    });

    // Let tab-switching shortcuts pass through to parent
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && ['1', '2', '3', '[', ']'].includes(e.key)) return false;
      if (e.ctrlKey && e.key === 'Tab') return false;
      // Cmd+F → open search overlay (handled in React, not in PTY)
      if (e.type === 'keydown' && e.metaKey && e.key === 'f') {
        setSearchOpen(true);
        // Defer focus until React renders the input
        setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 0);
        return false;
      }
      // Cmd+←/→ → beginning/end of line
      if (e.type === 'keydown' && e.metaKey && e.key === 'ArrowLeft') { term.input('\x01'); return false; }
      if (e.type === 'keydown' && e.metaKey && e.key === 'ArrowRight') { term.input('\x05'); return false; }
      if (e.type === 'keydown' && e.metaKey && e.key === 'k') { term.clear(); return false; }
      // Shift+Enter → Ctrl+J (line feed) for Claude Code multi-line input
      if (e.shiftKey && e.key === 'Enter') { if (e.type === 'keydown') term.input('\x0a'); return false; }
      return true;
    });

    // Terminal input → main process
    term.onData((data) => {
      window.electronAPI.terminalInput(data);
    });

    // Main process → terminal output
    window.electronAPI.onTerminalData((_event: any, data: string) => {
      term.write(data);
    });

    // Terminal process exited
    window.electronAPI.onTerminalExit(() => {
      spawnedRef.current = false;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        window.electronAPI.terminalResize(xtermRef.current.cols, xtermRef.current.rows);
      }
    });
    resizeObserver.observe(termRef.current);

    // Fit, focus, and connect to PTY
    setTimeout(async () => {
      fitAddon.fit();
      term.focus();
      window.electronAPI.terminalResize(term.cols, term.rows);

      const alreadySpawned = await window.electronAPI.terminalIsSpawned();
      spawnedRef.current = true;
      if (!alreadySpawned) {
        window.electronAPI.terminalSpawn({ cols: term.cols, rows: term.rows });
      } else {
        window.electronAPI.terminalAttach(term.cols, term.rows);
      }
    }, 50);
  }, [visible]);

  // Re-focus when switching back to terminal tab (no re-fit needed — visibility preserves layout)
  useEffect(() => {
    if (!visible || !initializedRef.current || !xtermRef.current) return;
    xtermRef.current.focus();
  }, [visible]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', backgroundColor: '#1e1e1e' }}>
      <div
        ref={termRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      />
      {searchOpen && (
        <div
          style={{
            position: 'absolute',
            top: '6px',
            right: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            backgroundColor: '#252526',
            border: '1px solid #454545',
            borderRadius: '3px',
            padding: '4px 6px',
            zIndex: 20,
            fontSize: '12px',
            color: '#cccccc',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder="Find"
            onChange={(e) => {
              setSearchQuery(e.target.value);
              findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) findPrevious(searchQuery);
                else findNext(searchQuery);
              }
            }}
            style={{
              width: '180px',
              padding: '2px 6px',
              backgroundColor: '#3c3c3c',
              border: '1px solid #3c3c3c',
              borderRadius: '2px',
              color: '#cccccc',
              fontSize: '12px',
              outline: 'none',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#007fd4'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#3c3c3c'; }}
          />
          <span
            style={{
              minWidth: '52px',
              textAlign: 'center',
              fontSize: '11px',
              color: searchQuery && searchResult && searchResult.resultCount === 0 ? '#f48771' : '#888',
            }}
          >
            {searchQuery
              ? searchResult && searchResult.resultCount > 0
                ? `${searchResult.resultIndex + 1} of ${searchResult.resultCount}`
                : 'No results'
              : ''}
          </span>
          <button
            onClick={() => findPrevious(searchQuery)}
            title="Previous match (Shift+Enter)"
            style={searchButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3c3c3c'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            ↑
          </button>
          <button
            onClick={() => findNext(searchQuery)}
            title="Next match (Enter)"
            style={searchButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3c3c3c'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            title="Close (Escape)"
            style={searchButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#3c3c3c'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            ✕
          </button>
        </div>
      )}
      <button
        onClick={() => onLaunchExternal?.()}
        title="Open new Claude session in external terminal (uses current working directory)"
        style={{
          position: 'absolute',
          bottom: '6px',
          right: '8px',
          backgroundColor: 'rgba(30, 30, 30, 0.85)',
          border: '1px solid #444',
          borderRadius: '3px',
          padding: '2px 8px',
          fontSize: '11px',
          color: '#888',
          cursor: 'pointer',
          lineHeight: '18px',
          zIndex: 10,
          opacity: 0.6,
          transition: 'opacity 0.2s, border-color 0.2s, color 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = '#00BCD4'; e.currentTarget.style.color = '#ddd'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#888'; }}
      >
        Claude in Terminal
      </button>
    </div>
  );
};

export default TerminalTab;
