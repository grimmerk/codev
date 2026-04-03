// Side-effect module: must be imported FIRST in main.ts.
// Wraps process.stdout/stderr.write to prevent EPIPE crashes.
// Node 24 throws EPIPE synchronously when pipe breaks (e.g., Electron dev mode).
const _stdoutWrite = process.stdout.write.bind(process.stdout);
const _stderrWrite = process.stderr.write.bind(process.stderr);
(process.stdout as any).write = (...args: any[]) => {
  try { return _stdoutWrite(...args); } catch { return true; }
};
(process.stderr as any).write = (...args: any[]) => {
  try { return _stderrWrite(...args); } catch { return true; }
};
