export interface VSCodeBasedWorkspace {
  configPath: string; // e.g. file:///Users/username/git/xx/yy.code-workspace
  id: string; //
}

export interface VSCodeBasedEntry {
  folderUri?: string; // e.g. file:///Users/username/git/zz
  workspace?: VSCodeBasedWorkspace;
  fileUri?: string;
}

export interface VSCodeBasedSqlite {
  entries?: Array<VSCodeBasedEntry>;
}
