import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const TerminalTab = ({ visible }: { visible: boolean }) => {
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
        cursor: '#00BCD4',
        selectionBackground: 'rgba(0, 188, 212, 0.3)',
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // Let tab-switching shortcuts pass through to parent
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && ['1', '2', '3', '[', ']'].includes(e.key)) return false;
      if (e.ctrlKey && e.key === 'Tab') return false;
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

  // Re-fit and focus when switching back to terminal tab
  useEffect(() => {
    if (!visible || !initializedRef.current || !xtermRef.current || !fitAddonRef.current) return;
    setTimeout(() => {
      fitAddonRef.current?.fit();
      const term = xtermRef.current;
      if (term) {
        window.electronAPI.terminalResize(term.cols, term.rows);
        term.focus();
      }
    }, 50);
  }, [visible]);

  return (
    <div
      ref={termRef}
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1e1e1e',
      }}
    />
  );
};

export default TerminalTab;
