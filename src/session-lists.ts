/**
 * Saved session lists (issue #145): a named snapshot of the sessions that
 * were open at one moment, on the Session Buddy model — save what is open,
 * put the windows down, come back to the list later.
 *
 * This is NOT the pinned zone. A pin is "this matters long-term"; a list is
 * "this is what I had open on Tuesday". Both are keyed by sessionId and both
 * drift across `/branch` (issue #142) in the same way.
 *
 * What a member stores is the point of the feature. A bare sessionId is
 * useless for recall, so each member carries the material a person actually
 * recognises a session by, captured at save time: title, branch, the recap
 * line Claude Code writes into the transcript (`away_summary`), and the last
 * user / assistant messages — every text field capped, so a 30-session list
 * stays a few tens of KB.
 *
 * Store: ~/.config/codev/session-lists.json, beside the marks store, using
 * the same authoritative-read / atomic-write / directory-watch machinery
 * (`atomic-json-store.ts`). Pure helpers first, fs wrappers below.
 */

import * as os from 'os';
import * as path from 'path';

import {
  mutateStoreFile,
  readStoreResult,
  StoreRead,
  watchStoreFile,
  writeStoreFile,
} from './atomic-json-store';

/** Per-field caps. The recap is already capped at 400 by Claude Code. */
export const LIST_TEXT_CAPS = {
  name: 80,
  title: 200,
  recap: 400,
  message: 500,
} as const;

export interface SessionListRecap {
  text: string;
  /** ISO time the recap was written — a recap can lag the session's last activity. */
  at: string;
}

export interface SessionListMember {
  sessionId: string;
  project: string;
  projectName: string;
  accountLabel?: string;
  title?: string;
  branch?: string;
  /** Pin state AT CAPTURE — a snapshot, never updated when the pin changes later. */
  pinned: boolean;
  /** Session's last activity at capture (unix ms). */
  lastTimestamp: number;
  recap?: SessionListRecap;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

export interface SessionList {
  id: string;
  name: string;
  createdAt: string; // ISO
  members: SessionListMember[];
}

export interface SessionLists {
  version: 1;
  lists: SessionList[];
}

export const emptyLists = (): SessionLists => ({ version: 1, lists: [] });

const capText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
};

/** Coerce one unknown member record; null when it cannot be a member at all. */
export const normalizeMember = (raw: unknown): SessionListMember | null => {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.sessionId !== 'string' || !m.sessionId) return null;
  const project = typeof m.project === 'string' ? m.project : '';
  const member: SessionListMember = {
    sessionId: m.sessionId,
    project,
    projectName:
      capText(m.projectName, LIST_TEXT_CAPS.title) ||
      project.split('/').filter(Boolean).pop() ||
      m.sessionId.slice(0, 8),
    pinned: m.pinned === true,
    lastTimestamp:
      typeof m.lastTimestamp === 'number' && Number.isFinite(m.lastTimestamp)
        ? m.lastTimestamp
        : 0,
  };
  const accountLabel = capText(m.accountLabel, LIST_TEXT_CAPS.name);
  if (accountLabel) member.accountLabel = accountLabel;
  const title = capText(m.title, LIST_TEXT_CAPS.title);
  if (title) member.title = title;
  const branch = capText(m.branch, LIST_TEXT_CAPS.title);
  if (branch) member.branch = branch;
  if (m.recap && typeof m.recap === 'object') {
    const r = m.recap as Record<string, unknown>;
    const text = capText(r.text, LIST_TEXT_CAPS.recap);
    if (text) {
      member.recap = {
        text,
        at: typeof r.at === 'string' ? r.at : new Date(0).toISOString(),
      };
    }
  }
  const lastUser = capText(m.lastUserMessage, LIST_TEXT_CAPS.message);
  if (lastUser) member.lastUserMessage = lastUser;
  const lastAssistant = capText(m.lastAssistantMessage, LIST_TEXT_CAPS.message);
  if (lastAssistant) member.lastAssistantMessage = lastAssistant;
  return member;
};

/** Coerce one unknown list record; null when it has no usable identity. */
export const normalizeList = (raw: unknown): SessionList | null => {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.id !== 'string' || !l.id) return null;
  const members: SessionListMember[] = [];
  const seen = new Set<string>();
  if (Array.isArray(l.members)) {
    for (const item of l.members) {
      const m = normalizeMember(item);
      if (!m || seen.has(m.sessionId)) continue;
      seen.add(m.sessionId);
      members.push(m);
    }
  }
  return {
    id: l.id,
    name: capText(l.name, LIST_TEXT_CAPS.name) || 'untitled',
    createdAt:
      typeof l.createdAt === 'string' ? l.createdAt : new Date(0).toISOString(),
    members,
  };
};

/** Coerce unknown JSON into valid SessionLists (drops malformed entries). */
export const normalizeLists = (raw: unknown): SessionLists => {
  const lists = emptyLists();
  if (!raw || typeof raw !== 'object') return lists;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.lists)) return lists;
  const seen = new Set<string>();
  for (const item of obj.lists) {
    const l = normalizeList(item);
    if (!l || seen.has(l.id)) continue;
    seen.add(l.id);
    lists.lists.push(l);
  }
  return lists;
};

/** Newest first — a saved list is browsed the way it was made, by time. */
export const withList = (
  lists: SessionLists,
  list: SessionList,
): SessionLists => ({
  version: 1,
  lists: [list, ...lists.lists.filter((l) => l.id !== list.id)],
});

export const withoutList = (lists: SessionLists, id: string): SessionLists => ({
  version: 1,
  lists: lists.lists.filter((l) => l.id !== id),
});

export const withRenamedList = (
  lists: SessionLists,
  id: string,
  name: string,
): SessionLists => ({
  version: 1,
  lists: lists.lists.map((l) =>
    l.id === id
      ? { ...l, name: capText(name, LIST_TEXT_CAPS.name) || l.name }
      : l,
  ),
});

// --- fs layer (path-based, testable; default-path wrappers below) ---

const LISTS_FILENAME = 'session-lists.json';

export type ListsRead = StoreRead<SessionLists>;

export const readListsFileResult = (filePath: string): ListsRead =>
  readStoreResult(filePath, normalizeLists, emptyLists);

export const writeListsFile = (filePath: string, lists: SessionLists): void =>
  writeStoreFile(filePath, lists);

export const mutateListsFile = (
  filePath: string,
  mutate: (lists: SessionLists) => SessionLists,
): ListsRead => mutateStoreFile(filePath, normalizeLists, emptyLists, mutate);

export const watchListsFile = (
  filePath: string,
  onChange: (lists: SessionLists) => void,
  onError?: (err: Error) => void,
): (() => void) =>
  watchStoreFile(filePath, readListsFileResult, onChange, onError);

const defaultListsPath = (): string =>
  path.join(os.homedir(), '.config', 'codev', LISTS_FILENAME);

export const readSessionListsResult = (): ListsRead =>
  readListsFileResult(defaultListsPath());

export const mutateSessionLists = (
  mutate: (lists: SessionLists) => SessionLists,
): ListsRead => mutateListsFile(defaultListsPath(), mutate);

export const watchSessionLists = (
  onChange: (lists: SessionLists) => void,
  onError?: (err: Error) => void,
): (() => void) => watchListsFile(defaultListsPath(), onChange, onError);
