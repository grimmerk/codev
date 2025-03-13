declare module 'better-sqlite3' {
  class Database {
    constructor(path: string, options?: { readonly?: boolean });
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
  }

  class Statement {
    run(...params: any[]): { lastInsertRowid: number; changes: number };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  export = Database;
}