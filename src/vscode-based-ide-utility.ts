import { VSWindow as VSWindowModel } from '@prisma/client';
import Database from 'better-sqlite3';
import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { IDEMode } from './ide-enum';
import {
  VSCodeBasedEntry,
  VSCodeBasedSqlite,
} from './vscode-based-ide-sqlite.type';

// Will be updated from settings
let currentIDEMode = IDEMode.VSCode;

// Override paths from security-scoped bookmarks (used in MAS sandbox)
const ideDataOverridePaths: Record<string, string> = {};

// Function to update the current IDE mode from settings
export const updateCurrentIDEMode = (preferredIDE: string) => {
  if (preferredIDE === IDEMode.Cursor || preferredIDE === IDEMode.VSCode) {
    currentIDEMode = preferredIDE as IDEMode;
  }
};

/**
 * Set an override path for IDE data access (from security-scoped bookmark).
 * In MAS sandbox, os.homedir() may return a different path than what the
 * bookmark grants access to. Using the actual selected path ensures access.
 */
export const updateIDEDataPath = (ideMode: string, folderPath: string) => {
  ideDataOverridePaths[ideMode] = folderPath;
  console.log(`updateIDEDataPath [${ideMode}]:`, folderPath);
};

export const VSCodeBasedIDEStateFilePath = () => {
  // If we have an override path from security-scoped bookmark, use it.
  // In MAS sandbox, os.homedir() may not match the bookmark-granted path.
  const overridePath = ideDataOverridePaths[currentIDEMode];
  if (overridePath) {
    // The override path points to the selected folder (e.g. globalStorage or User).
    // We need to find state.vscdb relative to it.
    const directPath = path.join(overridePath, 'state.vscdb');
    const nestedPath = path.join(overridePath, 'globalStorage', 'state.vscdb');
    // Check if state.vscdb is directly in the folder or nested under globalStorage
    try {
      const fs = require('fs');
      if (fs.existsSync(directPath)) {
        return directPath;
      }
      if (fs.existsSync(nestedPath)) {
        return nestedPath;
      }
    } catch (e) {
      console.error('Error checking override paths:', e);
    }
    // Fallback: assume it's directly in the folder
    console.log('Override path set but state.vscdb not found at:', directPath, 'or', nestedPath);
  }

  const homePath = os.homedir();
  if (currentIDEMode === IDEMode.VSCode) {
    const dbPath = path.join(
      homePath,
      /** VSCode may have some variants, e.g. insider, so "Code" -> others */
      '/Library/Application Support/Code/User/globalStorage/state.vscdb',
    );
    return dbPath;
  } else {
    //if (currentIDEMode === IDEMode.Cursor){
    const dbPath = path.join(
      homePath,
      'Library/Application Support/Cursor/User/globalStorage/state.vscdb',
    );
    return dbPath;
  }
};

export const readVSCodeBasedIDEState = (): VSWindowModel[] => {
  const dbPath = VSCodeBasedIDEStateFilePath();
  const fs = require('fs');
  const fileExists = fs.existsSync(dbPath);
  console.log('readVSCodeBasedIDEState, dbPath:', dbPath, 'exists:', fileExists, 'mode:', currentIDEMode,
    'overridePath:', ideDataOverridePaths[currentIDEMode] || 'none');

  let jsonData: VSCodeBasedSqlite = {}; //VSWindowModel[] = []

  const profileIDEstateLog = 'read VSCode base state:' + currentIDEMode;
  try {
    console.time(profileIDEstateLog);

    const db = new Database(dbPath, { readonly: true });

    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('history.recentlyOpenedPathsList');

    if (row) {
      console.time('data to string');

      const binaryData = row.value;

      const jsonString = Buffer.from(binaryData).toString('utf-8');

      try {
        jsonData = JSON.parse(jsonString);
        // return jsonData;
      } catch (e) {
        console.log('Fail to parse JSON:', jsonString);
      }
    } else {
      console.log('Not found key');
    }

    db.close();
  } catch (error) {
    console.error('error to open or read sqlite:', error);
  }

  console.timeEnd(profileIDEstateLog);

  // console.log('IDE state:', jsonData);

  if (jsonData.entries) {
    // Separate folders/workspaces and files to ensure file items
    // are always included regardless of how many folders exist
    const foldersAndWorkspaces = jsonData.entries
      .filter((entry: VSCodeBasedEntry) => entry.folderUri || entry.workspace)
      .slice(0, 100);
    const files = jsonData.entries
      .filter((entry: VSCodeBasedEntry) => entry.fileUri)
      .slice(0, 50);
    jsonData.entries = [...foldersAndWorkspaces, ...files];
  }

  const resp = convertVSCodeBasedSqliteToVSWindowModelArray(jsonData);
  return resp;
};

/**
 * Delete a specific entry from Cursor's SQLite database
 * @param {string} entryToDelete - Path or workspace ID to delete
 * @param {boolean} isWorkspace - Whether it's a workspace (true) or folder (false)
 * @returns {boolean} - Whether deletion was successful
 */
async function deleteVSCodeBasedIDEEntry(
  entryToDelete: string,
  isWorkspace = false,
) {
  console.log('deleteVSCodeBasedIDEEntry', entryToDelete, isWorkspace);
  // Build database path
  const dbPath = VSCodeBasedIDEStateFilePath(); //path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  let db = null;

  try {
    // Connect to database
    console.time('Open database');
    db = new Database(dbPath, { readonly: false }); // Note: need write mode
    console.timeEnd('Open database');

    // Start transaction
    db.prepare('BEGIN TRANSACTION').run();

    // Read current data
    console.time('Read data');
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('history.recentlyOpenedPathsList');
    console.timeEnd('Read data');

    if (!row || !row.value) {
      console.error('Project history not found');
      return false;
    }

    // Convert binary data to JSON
    console.time('Parse data');
    const binaryData = row.value;
    const jsonString = Buffer.from(binaryData).toString('utf-8');
    const jsonData = JSON.parse(jsonString);
    console.timeEnd('Parse data');

    // Check data format
    if (!jsonData.entries || !Array.isArray(jsonData.entries)) {
      console.error('Invalid data format, missing entries array');
      return false;
    }

    // Find and delete specified entry
    const originalLength = jsonData.entries.length;

    if (isWorkspace) {
      // Delete matching workspace
      jsonData.entries = jsonData.entries.filter((entry: VSCodeBasedEntry) => {
        // Keep entries without workspace property or with non-matching ID
        if (!entry.workspace) return true;

        console.log('workspace1:', entry?.workspace?.configPath);
        // Compare workspace ID or configPath
        return !(
          entry.workspace.id === entryToDelete ||
          entry.workspace.configPath === entryToDelete
        );
      });
    } else {
      // Delete matching folder
      jsonData.entries = jsonData.entries.filter((entry: VSCodeBasedEntry) => {
        // Keep entries without folderUri property
        if (!entry.folderUri) return true;

        // Compare folderUri
        return entry.folderUri !== entryToDelete;
      });
    }

    // Check if any entry was deleted
    if (jsonData.entries.length === originalLength) {
      console.log('No matching entry found');
      db.prepare('ROLLBACK').run();
      return false;
    }

    // Convert modified JSON back to binary and write to database
    console.time('Write data');
    const updatedJsonString = JSON.stringify(jsonData);
    const updatedBinaryData = Buffer.from(updatedJsonString);

    db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
      updatedBinaryData,
      'history.recentlyOpenedPathsList',
    );
    console.timeEnd('Write data');

    // Commit transaction
    db.prepare('COMMIT').run();

    console.log(
      `Successfully deleted project, reduced from ${originalLength} to ${jsonData.entries.length} entries`,
    );
    return true;
  } catch (error) {
    console.debug('Error deleting project entry:', error);
    // Rollback transaction on error
    if (db) {
      try {
        db.prepare('ROLLBACK').run();
      } catch (rollbackError) {
        console.error('Error rolling back transaction:', rollbackError);
      }
    }

    console.error('Error deleting project entry:', error);
    return false;
  } finally {
    // Close database connection
    if (db) {
      db.close();
    }
  }
}

export const openVSCodeBasedIDE = (
  path: string,
  ifForceReuseWin: boolean = false,
) => {
  let app: string;
  let bundleId: string;

  if (currentIDEMode === IDEMode.VSCode) {
    app = 'vscode';
    bundleId = 'com.microsoft.VSCode';
  } else {
    app = 'cursor';
    /** TODO: use osascript -e 'id of app "Cursor"' to get the cursor bundleId instead of hard-coded */
    bundleId = 'com.todesktop.230313mzl4w4u92';
  }

  /** TODO: use Node.js path.join() instead of manual concat */
  // FIXME: win/linux has difference path
  // ref:
  // 1. https://stackoverflow.com/questions/44405523/spawn-child-node-process-from-electron
  // 2. https://stackoverflow.com/questions/62885809/nodejs-child-process-npm-command-not-found
  // 3. https://github.com/electron/fiddle/issues/365#issuecomment-616630874
  // const fullCmd = `code ${command}`
  // const child = spawn('open', ['-b', 'com.microsoft.VSCode', '--args', argv], options);
  // https://github.com/microsoft/vscode/issues/102975#issuecomment-661647219
  // const fullCmd = `open -b com.microsoft.VSCode --args -r ${path}`

  let fullCmd = '';
  const newPath = path.replace(/ /g, '\\ ');
  if (ifForceReuseWin) {
    // reuse
    // https://stackoverflow.com/a/47473271/7354486
    // https://code.visualstudio.com/docs/editor/command-line#_opening-vs-code-with-urls
    fullCmd = `open ${app}://file/${newPath}`;
  } else {
    // NOTE: VSCode insider needs to use "com.microsoft.VSCodeInsiders" instead
    fullCmd = `open -b ${bundleId} ${newPath}`;
  }

  exec(fullCmd, (error, stdout, stderr) => {});
};

const convertVSCodeBasedSqliteToVSWindowModelArray = (
  sqlite: VSCodeBasedSqlite,
): VSWindowModel[] => {
  /** TODO: only get the first 100 records, as what we did in xwin.controller.ts */

  /**
   * what we really uses in switcher-ui.tsx, as of 2025-03-12
   * 1. path:
   * 2.
   * 3.
   */
  const { entries = [] } = sqlite;

  const resp: VSWindowModel[] = entries.map((entry, index) => {
    let isSpace = false;
    let path: string;
    if (entry.folderUri) {
      // NOTE: !! remove "file://"
      path = entry.folderUri.substring(7);
    } else if (entry.workspace) {
      // console.log('workspace2:', entry?.workspace?.configPath);
      // if (!entry.workspace?.configPath) {
      //   console.log('sqlite', sqlite);
      //   console.log('binggo');
      // }

      path = entry.workspace.configPath.substring(7);
      isSpace = true;
    } else if (entry.fileUri) {
      // Handle file URIs for file history support
      // Decode URI to handle spaces and special characters
      path = decodeURIComponent(entry.fileUri.substring(7));
    }

    return {
      path,
      // dummy fields:
      id: 0, // number. VSCode built-in sqlite does not have this
      createdAt: null, // Date. VSCode built-in sqlite does not have this
      updatedAt: null, // Date  VSCode built-in sqlite does not have this
      closed: false,
      isSpace: isSpace,
      name: null,
      spaceParentId: null, // number type
      inSpace: false, //  VSCode built-in sqlite does not have this
    } as VSWindowModel;
  });

  // console.log('convertVSCodeBasedSqliteToVSWindowModelArray:', resp);
  return resp;
};

export const SERVER_URL = 'http://localhost:55688';

// export const fetchVSCodeBasedOpenedWindows = async (): Promise<VSWindowModel[]> => {
//     // const url = `${SERVER_URL}/xwins`;
//     // const resp = await fetch(url);
//     // const json = await resp.json();
//     // return json
//     return []
// }

export const deleteRecentProjectRecord = async (path: string) => {
  // const url = `${SERVER_URL}/xwins`;
  // const headers = {
  //   'Content-Type': 'application/json',
  //   Accept: 'application/json',
  // };
  // /** e.g. /Users/grimmer/git/alphago-zero-tictactoe-js */
  // console.log("deleteRecentProjectRecord:", path)
  // await fetch(url, {
  //   body: JSON.stringify({ path }),
  //   method: 'DELETE',
  //   headers,
  // });

  const isWorkspace = path.indexOf('code-workspace') > -1 ? true : false;

  const fullPath = 'file://' + path;
  await deleteVSCodeBasedIDEEntry(fullPath, isWorkspace);
};

/**
 * Detect which project folders are currently open in VS Code or Cursor.
 * Uses AppleScript to get window titles from the IDE process.
 * Returns a Set of folder names (last path component) that have open windows.
 */
let cachedActiveIDEFolders: Set<string> | null = null;
let activeIDECacheTimestamp = 0;
const ACTIVE_IDE_CACHE_TTL_MS = 5000;

export const detectActiveIDEProjects = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (cachedActiveIDEFolders && (now - activeIDECacheTimestamp) < ACTIVE_IDE_CACHE_TTL_MS) {
    return cachedActiveIDEFolders;
  }
  const processName = currentIDEMode === IDEMode.Cursor ? 'Cursor' : 'Code';
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });

  const script = `tell application "System Events"
  if exists (process "${processName}") then
    tell process "${processName}"
      set windowNames to {}
      repeat with w in (every window)
        set end of windowNames to name of w
      end repeat
      return windowNames
    end tell
  end if
end tell`;

  const output = await execPromise(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
  if (!output.trim()) return new Set();

  const folderNames = new Set<string>();
  // Window titles can be: "folderName", "file — folderName", "file — folderName — IDE"
  // The " — " (em dash) is VS Code/Cursor's separator
  const titles = output.trim().split(', ');
  for (const title of titles) {
    const parts = title.split(' \u2014 ');
    if (parts.length >= 2) {
      // "file — folder" or "file — folder — IDE": folder is second-to-last
      const folderPart = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
      if (folderPart) folderNames.add(folderPart.trim());
    } else if (parts.length === 1 && title.trim() && title.trim() !== 'Welcome') {
      // Single-part title could be just the folder name
      folderNames.add(title.trim());
    }
  }

  cachedActiveIDEFolders = folderNames;
  activeIDECacheTimestamp = now;
  return folderNames;
};
