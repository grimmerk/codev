/**
 * Telling the user that a switch was cut short. The terminal scripts run
 * with a 5 s timeout; when it fires, the command is killed and, until now,
 * nothing happened on screen. This module carries that one fact from the
 * `osascript` callback to whoever shows it (main.ts sends it to the
 * switcher window's banner).
 *
 * There is no retry: one that lands 5–10 s later would take the focus away
 * from whatever the user has moved on to.
 *
 * No Electron imports, and nothing here throws into the switch path.
 */

/** The `timeout` of the terminal scripts' `exec` calls, in seconds. */
export const SWITCH_SCRIPT_TIMEOUT_S = 5;

const DISPLAY_NAMES: Record<string, string> = {
  ghostty: 'Ghostty',
  iterm2: 'iTerm2',
  'terminal.app': 'Terminal.app',
};

/** The banner text. `terminal` is a fixed label from the code, never user text. */
export const switchKilledMessage = (terminal?: string): string => {
  const name = terminal ? DISPLAY_NAMES[terminal.toLowerCase()] ?? terminal : 'The terminal';
  return `${name} did not answer within ${SWITCH_SCRIPT_TIMEOUT_S} s, so the switch was cancelled. The machine may be busy — try again.`;
};

let listener: ((message: string) => void) | null = null;

/** main.ts registers the one place a notice goes to. */
export const setSwitchKilledListener = (fn: ((message: string) => void) | null): void => {
  listener = fn;
};

/**
 * Call from an `exec` callback with its error. Does something only when the
 * command was stopped by its timeout (`error.killed`); any other failure is
 * the caller's to handle, as before.
 */
export const noteSwitchKilled = (error: unknown, terminal?: string): void => {
  try {
    if (!error || (error as { killed?: unknown }).killed !== true) return;
    listener?.(switchKilledMessage(terminal));
  } catch {
    // A notice that cannot be shown must not disturb the switch path.
  }
};

/** A notice not shown within this long is dropped: it would describe old news. */
export const SWITCH_NOTICE_TTL_MS = 2 * 60 * 1000;

export interface PendingNotice {
  /** Keep a message for a window that is hidden now. The latest one wins. */
  hold(message: string): void;
  /** The held message, once, if it is still fresh; else null. */
  take(): string | null;
}

/**
 * In Menu Bar mode the window hides as a row is clicked, so there is no
 * banner to show the notice in when the kill arrives 5 s later. It is held
 * here and shown the next time the window opens.
 */
export const createPendingNotice = (
  now: () => number = Date.now,
  ttlMs: number = SWITCH_NOTICE_TTL_MS,
): PendingNotice => {
  let held: { message: string; at: number } | null = null;
  return {
    hold: (message) => {
      held = { message, at: now() };
    },
    take: () => {
      const h = held;
      held = null;
      return h && now() - h.at <= ttlMs ? h.message : null;
    },
  };
};
