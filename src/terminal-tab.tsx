import { useEffect, useRef } from 'react';

let Terminal: any;
let FitAddon: any;

const TerminalTab = ({ visible }: { visible: boolean }) => {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const spawnedRef = useRef(false);
  const loadedRef = useRef(false);

  // Load xterm.js dynamically to avoid webpack production tree-shaking issues
  const loadXterm = async () => {
    if (loadedRef.current) return true;
    try {
      const xtermModule = await import('@xterm/xterm');
      const fitModule = await import('@xterm/addon-fit');
      Terminal = xtermModule.Terminal;
      FitAddon = fitModule.FitAddon;
      // Load CSS — ignore TS error for CSS import
      // @ts-ignore
      await import('@xterm/xterm/css/xterm.css');
      loadedRef.current = true;
      return true;
    } catch {
      return false;
    }
  };

  // Initialize xterm once when first visible
  useEffect(() => {
    if (!visible || !termRef.current || xtermRef.current) return;

    const init = async () => {
      if (!(await loadXterm())) return;
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
      term.onData((data: string) => {
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
    };

    init();
  }, [visible]);

  // Re-fit and focus when switching back to terminal tab
  useEffect(() => {
    if (!visible || !xtermRef.current || !fitAddonRef.current) return;
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
