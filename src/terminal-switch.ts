/**
 * The AppleScript that jumps to a running session's tab (iTerm2,
 * Terminal.app and Ghostty; cmux has its own CLI path). Two keys can
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
 *
 * **How each key is looked up: one bulk read, then the old loop only as a
 * fallback (issue #177).** Asking the terminal app about one tab at a time
 * costs an Apple event per window, tab and terminal, about 40–56 ms per
 * window on a busy machine — 1.4 s for 25 windows, and the script is killed
 * at 5 s. So each step first reads the key of EVERY item in one statement
 * (`tty of every session of every tab of every window` returns a list per
 * window, per tab), finds the first match inside the script with no Apple
 * events, then reads that one item's key again and brings it forward only
 * if it still matches — the windows can be reordered between the read and
 * the focus. The match order is the loop's (window, then tab, then
 * terminal), so a title or cwd shared by several tabs picks the same one as
 * before. If the bulk read fails (an app or version without it, a window
 * closing mid-read) or the second read disagrees, that step runs the old
 * per-item loop. A bulk read that succeeds and matches nothing moves on to
 * the next step: the loop would read the same values. Every return carries
 * `LOOP_MARK` when a fallback loop ran, so the timing log can tell the two
 * paths apart (`scan`).
 */
export type SwitchOrder = 'tty-first' | 'title-first';

export const switchOrderFor = (pidExact: boolean): SwitchOrder =>
  pidExact ? 'tty-first' : 'title-first';

/** Inside an AppleScript double-quoted literal: backslash and quote. */
export const escapeAppleScript = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Appended to a script's result when a step had to fall back to the
 * per-item loop: `found-by-tty (loop)`. Absent: every step that ran used
 * the bulk read. Read back by `splitSwitchOutput`.
 */
export const LOOP_MARK = ' (loop)';

/** A script's printed result without `LOOP_MARK`, and whether it was there. */
export const splitSwitchOutput = (
  stdout: string | undefined,
): { result: string; loop: boolean } => {
  const out = (stdout || '').trim();
  return out.endsWith(LOOP_MARK)
    ? { result: out.slice(0, -LOOP_MARK.length), loop: true }
    : { result: out, loop: false };
};

/** Every exit of a switch script says which path it took. */
const ret = (value: string): string => `return "${value}" & cvLoop`;

const indent = (text: string, by: number): string =>
  text
    .split('\n')
    .map((l) => (l ? ' '.repeat(by) + l : l))
    .join('\n');

const TTY_LOOKUP = (pid: number): string =>
  `set targetTty to do shell script "ps -o tty= -p ${pid} 2>/dev/null | tr -d '[:space:]'"`;

/**
 * Where one item sits below `every window` in an app's object model, and
 * how to bring it forward once found. `bind` turns the indexes the bulk
 * read gave (`cvW` window, `cvT` tab, `cvK` the item in the tab) into the
 * variable `item`; each app answers that `get` with an id-based reference
 * (`terminal id "…"`, `session id "…" of tab 2 of window id 8572`,
 * `tab 2 of window id 8733`), so the second read and the focus act on the
 * same object even if the windows are reordered in between.
 */
interface AppShape {
  /** `terminal of every tab of every window` */
  every: string;
  /** List levels below the window: 1 = tabs (Terminal.app), 2 = tabs, then items. */
  depth: 1 | 2;
  bind: string;
  item: string;
  focus: string;
}

const GHOSTTY: AppShape = {
  every: 'terminal of every tab of every window',
  depth: 2,
  bind: 'set term to terminal cvK of tab cvT of window cvW',
  item: 'term',
  focus: 'focus term',
};

const ITERM2: AppShape = {
  every: 'session of every tab of every window',
  depth: 2,
  bind: 'set w to window cvW\nset t to tab cvT of w\nset s to session cvK of t',
  item: 's',
  focus: 'select s\nselect t\nset index of w to 1',
};

const TERMINAL: AppShape = {
  every: 'tab of every window',
  depth: 1,
  bind: 'set w to window cvW\nset t to tab cvT of w',
  item: 't',
  focus: 'set selected tab of w to t\nset index of w to 1',
};

/**
 * One step (tty, title or cwd): the bulk read with its in-script search,
 * then `loop` — the step's old per-item loop — only if the bulk path
 * failed. `key` is the property read (`tty`, `«class Gtty»`, `name`, …),
 * `test` the comparison applied to it (`ends with targetTty`), `found` the
 * result returned on a match.
 */
const bulkStep = (
  shape: AppShape,
  key: string,
  test: string,
  found: string,
  loop: string,
): string => {
  // A missing value (a terminal with no tty yet, no known cwd) is skipped,
  // never compared: `missing value as text` is "missing value", which a
  // title could contain.
  const onMatch = `if cvV is not missing value then
  if cvV ${test} then
${indent(shape.bind, 4)}
    if (${key} of ${shape.item}) ${test} then
${indent(shape.focus, 6)}
      ${ret(found)}
    end if
    error "moved"
  end if
end if`;
  const search =
    shape.depth === 2
      ? `repeat with cvW from 1 to length of cvAll
  set cvL1 to item cvW of cvAll
  repeat with cvT from 1 to length of cvL1
    set cvL2 to item cvT of cvL1
    repeat with cvK from 1 to length of cvL2
      set cvV to item cvK of cvL2
${indent(onMatch, 6)}
    end repeat
  end repeat
end repeat`
      : `repeat with cvW from 1 to length of cvAll
  set cvL1 to item cvW of cvAll
  repeat with cvT from 1 to length of cvL1
    set cvV to item cvT of cvL1
${indent(onMatch, 4)}
  end repeat
end repeat`;
  return `set cvDone to false
try
  set cvAll to ${key} of every ${shape.every}
${indent(search, 2)}
  set cvDone to true
end try
if not cvDone then
  set cvLoop to "${LOOP_MARK}"
${indent(loop, 2)}
end if`;
};

// ── The per-item loops: today's lookup, kept as each step's fallback ──

const ITERM2_TTY_LOOP = `repeat with w in windows
  repeat with t in tabs of w
    repeat with s in sessions of t
      if tty of s ends with targetTty then
        select s
        select t
        set index of w to 1
        ${ret('found-by-tty')}
      end if
    end repeat
  end repeat
end repeat`;

const ITERM2_TITLE_LOOP = (title: string): string => `repeat with w in windows
  repeat with t in tabs of w
    repeat with s in sessions of t
      if name of s contains "${escapeAppleScript(title)}" then
        select s
        select t
        set index of w to 1
        ${ret('found-by-title')}
      end if
    end repeat
  end repeat
end repeat`;

const TERMINAL_TTY_LOOP = `repeat with w in windows
  repeat with t in tabs of w
    if tty of t ends with targetTty then
      set selected tab of w to t
      set index of w to 1
      ${ret('found-by-tty')}
    end if
  end repeat
end repeat`;

const TERMINAL_TITLE_LOOP = (title: string): string => `repeat with w in windows
  repeat with t in tabs of w
    if custom title of t contains "${escapeAppleScript(title)}" then
      set selected tab of w to t
      set index of w to 1
      ${ret('found-by-title')}
    end if
  end repeat
end repeat`;

// Ghostty exposes `tty` on its terminal class only from tip builds after
// ghostty#11922 (stable 1.3 has none). Two guards, because AppleScript
// resolves terminology against the app's dictionary at COMPILE time:
// `«class Gtty»` is the raw four-char code of that property, so the script
// still compiles where the dictionary lacks the word `tty`; and `try` turns
// the resulting runtime error on such a Ghostty into "no match", so title
// and cwd still run. Verified on tip build 18371: `«class Gtty»` returns the
// same `/dev/ttysNNN` as `tty`. (The bulk read sits in its own `try`, so on
// such a Ghostty it fails, this loop fails on its first terminal, and the
// step ends with no match.)
const GHOSTTY_TTY_LOOP = `try
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if («class Gtty» of term) ends with targetTty then
          focus term
          ${ret('found-by-tty')}
        end if
      end repeat
    end repeat
  end repeat
end try`;

const GHOSTTY_TITLE_LOOP = (title: string): string => `repeat with w in windows
  repeat with t in tabs of w
    repeat with term in terminals of t
      if name of term contains "${escapeAppleScript(title)}" then
        focus term
        ${ret('found-by-title')}
      end if
    end repeat
  end repeat
end repeat`;

const GHOSTTY_CWD_LOOP = (projectPath: string): string => `repeat with w in windows
  repeat with t in tabs of w
    repeat with term in terminals of t
      if working directory of term is "${escapeAppleScript(projectPath)}" then
        focus term
        ${ret('found-by-cwd')}
      end if
    end repeat
  end repeat
end repeat`;

// ── The steps ──

const ttyStep = (pid: number, shape: AppShape, key: string, loop: string, note: string): string =>
  `  -- tty matching (${note})
  ${TTY_LOOKUP(pid)}
  if targetTty is not "" then
${indent(bulkStep(shape, key, 'ends with targetTty', 'found-by-tty', loop), 4)}
  end if`;

const titleStep = (shape: AppShape, key: string, title: string, loop: string): string =>
  `  -- title matching (not unique across /branch siblings)
${indent(bulkStep(shape, key, `contains "${escapeAppleScript(title)}"`, 'found-by-title', loop), 2)}`;

// Last resort, Ghostty only: the first terminal sitting in the project
// directory. Wrong whenever two sessions share a cwd — which is why tty and
// title run first.
const ghosttyCwdStep = (projectPath: string): string =>
  `  -- cwd matching (last resort: the first terminal in that directory)
${indent(
  bulkStep(
    GHOSTTY,
    'working directory',
    `is "${escapeAppleScript(projectPath)}"`,
    'found-by-cwd',
    GHOSTTY_CWD_LOOP(projectPath),
  ),
  2,
)}`;

const assemble = (
  app: 'iTerm2' | 'Terminal' | 'Ghostty',
  tty: string | undefined,
  title: string | undefined,
  order: SwitchOrder,
  fallback?: string,
): string => {
  const keyed =
    order === 'tty-first' ? [tty, title] : [title, tty];
  const blocks = [...keyed, fallback].filter((b): b is string => !!b);
  return `tell application "${app}"
  activate
  set cvLoop to ""
${blocks.join('\n')}
  ${ret('not found')}
end tell`;
};

export const buildITerm2SwitchScript = (
  pid: number,
  customTitle: string | undefined,
  order: SwitchOrder,
): string =>
  assemble(
    'iTerm2',
    ttyStep(pid, ITERM2, 'tty', ITERM2_TTY_LOOP, 'exact when the pid is'),
    customTitle
      ? titleStep(ITERM2, 'name', customTitle, ITERM2_TITLE_LOOP(customTitle))
      : undefined,
    order,
  );

/**
 * Ghostty: tty and title in the provenance order, then cwd as a last resort.
 * `pid` is optional — a session with no known process still gets title and
 * cwd, which is all Ghostty could do before its tip builds exposed `tty`.
 */
export const buildGhosttySwitchScript = (
  pid: number | undefined,
  customTitle: string | undefined,
  order: SwitchOrder,
  projectPath: string,
): string =>
  assemble(
    'Ghostty',
    pid
      ? ttyStep(
          pid,
          GHOSTTY,
          '«class Gtty»',
          GHOSTTY_TTY_LOOP,
          'exact when the pid is; Ghostty tip only',
        )
      : undefined,
    customTitle
      ? titleStep(GHOSTTY, 'name', customTitle, GHOSTTY_TITLE_LOOP(customTitle))
      : undefined,
    order,
    ghosttyCwdStep(projectPath),
  );

export const buildTerminalAppSwitchScript = (
  pid: number,
  customTitle: string | undefined,
  order: SwitchOrder,
): string =>
  assemble(
    'Terminal',
    ttyStep(pid, TERMINAL, 'tty', TERMINAL_TTY_LOOP, 'exact when the pid is'),
    customTitle
      ? titleStep(TERMINAL, 'custom title', customTitle, TERMINAL_TITLE_LOOP(customTitle))
      : undefined,
    order,
  );
