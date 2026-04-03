// Side-effect module: must be imported FIRST in main.ts.
// Prevents EPIPE crashes in Node 24 + Electron dev mode.

// 1) Register uncaughtException handler to suppress Electron's error dialog for EPIPE.
// Electron's init.ts checks: if (process.listenerCount('uncaughtException') > 1) return;
// By adding our listener, Electron's default handler skips the dialog.
process.on('uncaughtException', (error: Error & { code?: string }) => {
  if (error?.code === 'EPIPE' || error?.message?.includes('EPIPE')) return;
  // For non-EPIPE errors, show dialog ourselves
  try {
    const { dialog } = require('electron');
    const stack = error.stack || `${error.name}: ${error.message}`;
    dialog.showErrorBox('A JavaScript error occurred in the main process', 'Uncaught Exception:\n' + stack);
  } catch {}
});

// 2) Wrap process.stdout/stderr.write to catch synchronous EPIPE from console.*
const _stdoutWrite = process.stdout.write.bind(process.stdout);
const _stderrWrite = process.stderr.write.bind(process.stderr);
(process.stdout as any).write = (...args: any[]) => {
  try { return _stdoutWrite(...args); } catch { return true; }
};
(process.stderr as any).write = (...args: any[]) => {
  try { return _stderrWrite(...args); } catch { return true; }
};

// 3) Handle async error events on streams
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
