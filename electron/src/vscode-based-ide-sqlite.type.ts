export interface CursorWorkspace {
    configPath: string; // e.g. file:///Users/username/git/xx/yy.code-workspace    
    id: string; //
}

export interface CursorSqliteEntry {
    folderUri?: string; // e.g. file:///Users/username/git/zz 
    workspace?: CursorWorkspace 
}

export interface CursorSqlite {
  jsonData: {
    entries: Array<CursorSqliteEntry>;
  }
}
