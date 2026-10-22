/**
 * Detection's cross-reference, last step: a process's terminal tab has been
 * found by tty; which session does that tab belong to? The tab title carries
 * the session's `/rename` title, so pick the session whose title the tab
 * title contains.
 *
 * One rule for every terminal (iTerm2, cmux, Terminal.app, Ghostty), which
 * used to be four copies of a loop that took the FIRST title the tab
 * contained, from every transcript in the directory. Two defects followed:
 * a title that is a substring of another (`Fix` inside `Fix backend`) could
 * claim the tab, and a session with no row in the list (absent from history)
 * could claim it. So: only the queued candidates, and the LONGEST matching
 * title, which is the most specific one.
 */
export const pickSessionByTabTitle = (
  tabTitle: string,
  candidateIds: readonly string[],
  titles: ReadonlyMap<string, string>,
  isTaken: (sessionId: string) => boolean,
): string | undefined => {
  let best: { id: string; length: number } | undefined;
  for (const id of candidateIds) {
    const title = titles.get(id);
    if (!title || isTaken(id) || !tabTitle.includes(title)) continue;
    if (!best || title.length > best.length) best = { id, length: title.length };
  }
  return best?.id;
};
