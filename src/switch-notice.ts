/**
 * Telling the user that a terminal script was cut short. The Ghostty and
 * Terminal.app switch scripts, and the scripts that launch a session in
 * iTerm2, Ghostty or Terminal.app, run with a 5 s timeout; when it fires,
 * the command is killed and, until now, CodeV gave no feedback. (The iTerm2
 * switch runs without a timeout, so it never reports here.) This module
 * carries that one fact from the `osascript` callback to whoever shows it
 * (main.ts sends it to the switcher window's banner).
 *
 * A killed script did not finish, which is not the same as having done
 * nothing: AppleScript runs step by step, so the terminal may already have
 * been activated, or a launch command already submitted, when the kill
 * lands. The messages therefore say what is known and no more.
 *
 * There is no automatic retry: one that lands 5–10 s later would take the
 * focus away from whatever the user has moved on to.
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

/**
 * What the killed script was doing: `switch` — focusing the tab of a
 * running session; `launch` — opening a tab or window and typing a command
 * into it (a resume, a new session, a saved list's members).
 */
export type SwitchNoticeKind = 'switch' | 'launch';

/**
 * The banner text. `terminal` is a fixed label from the code, never user text.
 *
 * A launch gets its own wording because several launch scripts submit the
 * command BEFORE their last step (`new window with configuration` or
 * `do script`, then `activate`): the session may be starting although the
 * script was killed, and "try again" would open it twice.
 */
export const switchKilledMessage = (
  terminal?: string,
  kind: SwitchNoticeKind = 'switch',
): string => {
  const name = terminal ? DISPLAY_NAMES[terminal.toLowerCase()] ?? terminal : 'The terminal';
  return kind === 'launch'
    ? `${name} took more than ${SWITCH_SCRIPT_TIMEOUT_S} s to answer. The session may still be opening — check before trying again.`
    : `${name} did not answer within ${SWITCH_SCRIPT_TIMEOUT_S} s; the switch may not have completed. The machine may be busy.`;
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
export const noteSwitchKilled = (
  error: unknown,
  terminal?: string,
  kind: SwitchNoticeKind = 'switch',
): void => {
  try {
    if (!error || (error as { killed?: unknown }).killed !== true) return;
    listener?.(switchKilledMessage(terminal, kind));
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
 * In Menu Bar mode the window hides as a row is chosen, so there is no
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
