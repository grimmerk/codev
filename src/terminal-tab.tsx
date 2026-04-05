import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const TerminalTab = ({ visible, onLaunchExternal }: { visible: boolean; onLaunchExternal?: () => void }) => {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const initializedRef = useRef(false);

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
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // Let tab-switching shortcuts pass through to parent
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && ['1', '2', '3', '[', ']'].includes(e.key)) return false;
      if (e.ctrlKey && e.key === 'Tab') return false;
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
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#1e1e1e' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '2px 8px',
        gap: '6px',
        flexShrink: 0,
      }}>
        <button
          onClick={() => onLaunchExternal?.()}
          title="Open new Claude session in external terminal (uses current working directory)"
          style={{
            backgroundColor: 'transparent',
            border: '1px solid #444',
            borderRadius: '3px',
            padding: '1px 8px',
            fontSize: '11px',
            color: '#aaa',
            cursor: 'pointer',
            lineHeight: '18px',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#00BCD4'; e.currentTarget.style.color = '#ddd'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#444'; e.currentTarget.style.color = '#aaa'; }}
        >
          Claude in Terminal
        </button>
      </div>
      <div
        ref={termRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          backgroundColor: '#1e1e1e',
        }}
      />
    </div>
  );
};

export default TerminalTab;
