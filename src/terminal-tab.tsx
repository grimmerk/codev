import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const TerminalTab = ({ visible }: { visible: boolean }) => {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);

  // Initialize xterm once
  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

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

    // Terminal input → main process
    term.onData((data) => {
      window.electronAPI.terminalInput(data);
    });

    // Main process → terminal output
    window.electronAPI.onTerminalData((_event: any, data: string) => {
      term.write(data);
    });

    // Terminal process exited — respawn
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

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Spawn terminal and re-fit when tab becomes visible
  useEffect(() => {
    if (!visible || !xtermRef.current || !fitAddonRef.current) return;

    // Re-fit and focus after tab switch (container may have been display:none)
    setTimeout(() => {
      fitAddonRef.current?.fit();
      const term = xtermRef.current;
      if (term) {
        window.electronAPI.terminalResize(term.cols, term.rows);
        term.focus();
      }

      // Spawn if not already running
      if (!spawnedRef.current && term) {
        spawnedRef.current = true;
        window.electronAPI.terminalSpawn({
          cols: term.cols,
          rows: term.rows,
        });
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
