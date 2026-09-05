/**
 * The AppleScript that jumps to a running session's tab (iTerm2 and
 * Terminal.app; the other terminals have their own paths). Two keys can
 * find the tab, and the ORDER they are tried in is the whole point of this
 * module:
 *
 * - **tty** — a process has exactly one controlling terminal, so this cannot
 *   pick a sibling. Exact when the pid is exact, and wrong when the pid was a
 *   guess: it then jumps to whatever tab the guessed process lives in.
 * - **title** — the session's `/rename` title. Unique only when the user
 *   kept it so: three `/branch` siblings under Claude Code 2.1.260 shared one
 *   (issue #142 C0), and a session opened twice does too.
 *
 * So the order follows where the pid came from (`SwitchOrder`): a pid read
 * from Claude Code's own `~/.claude/sessions/<pid>.json` and validated
 * against `ps` (PR #147) is exact → tty first; a pid attached to a row by
 * guessing from its cwd or from a terminal-tab title (the fallback detection
 * keeps for processes that never registered) → title first, the pre-#152
 * order that `868db59` (2026-03-21) chose for exactly that case. Both blocks
 * are always emitted when a title exists, so the second key is the fallback
 * either way. History and the flow diagram: docs/claude-session-integration-design.md.
 */
export type SwitchOrder = 'tty-first' | 'title-first';

export const switchOrderFor = (pidExact: boolean): SwitchOrder =>
  pidExact ? 'tty-first' : 'title-first';

/** Inside an AppleScript double-quoted literal: backslash and quote. */
export const escapeAppleScript = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const TTY_LOOKUP = (pid: number): string =>
  `set targetTty to do shell script "ps -o tty= -p ${pid} 2>/dev/null | tr -d '[:space:]'"`;

const ITERM2_TTY = (
  pid: number,
): string => `  -- tty matching (exact when the pid is)
  ${TTY_LOOKUP(pid)}
  if targetTty is not "" then
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s ends with targetTty then
            select s
            select t
            set index of w to 1
            return "found-by-tty"
          end if
        end repeat
      end repeat
    end repeat
  end if`;

const ITERM2_TITLE = (
  title: string,
): string => `  -- title matching (not unique across /branch siblings)
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s contains "${escapeAppleScript(title)}" then
          select s
          select t
          set index of w to 1
          return "found-by-title"
        end if
      end repeat
    end repeat
  end repeat`;

const TERMINAL_TTY = (
  pid: number,
): string => `  -- tty matching (exact when the pid is)
  ${TTY_LOOKUP(pid)}
  if targetTty is not "" then
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t ends with targetTty then
          set selected tab of w to t
          set index of w to 1
          return "found-by-tty"
        end if
      end repeat
    end repeat
  end if`;

const TERMINAL_TITLE = (
  title: string,
): string => `  -- title matching (not unique across /branch siblings)
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t contains "${escapeAppleScript(title)}" then
        set selected tab of w to t
        set index of w to 1
        return "found-by-title"
      end if
    end repeat
  end repeat`;

const assemble = (
  app: 'iTerm2' | 'Terminal',
  tty: string,
  title: string | undefined,
  order: SwitchOrder,
): string => {
  const blocks = title
    ? order === 'tty-first'
      ? [tty, title]
      : [title, tty]
    : [tty];
  return `tell application "${app}"
  activate
${blocks.join('\n')}
  return "not found"
end tell`;
};

export const buildITerm2SwitchScript = (
  pid: number,
  customTitle: string | undefined,
  order: SwitchOrder,
): string =>
  assemble(
    'iTerm2',
    ITERM2_TTY(pid),
    customTitle ? ITERM2_TITLE(customTitle) : undefined,
    order,
  );

export const buildTerminalAppSwitchScript = (
  pid: number,
  customTitle: string | undefined,
  order: SwitchOrder,
): string =>
  assemble(
    'Terminal',
    TERMINAL_TTY(pid),
    customTitle ? TERMINAL_TITLE(customTitle) : undefined,
    order,
  );
