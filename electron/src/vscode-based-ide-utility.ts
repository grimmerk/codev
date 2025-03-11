import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import {CursorSqliteEntry} from "./vscode-based-ide-sqlite.type"

export enum IDEMode {
  VSCode = 'VSCode',
  Cursor = 'Cursor'
}

const defaultIDEMode = IDEMode.VSCode;

export const IDEStateFilePath =()=>{
  const homePath = os.homedir();
  if (defaultIDEMode === IDEMode.VSCode){
    const dbPath = path.join(
      homePath,
      /** VSCode may have some variants, e.g. insider, so "Code" -> others */
      '/Library/Application Support/Code/User/globalStorage/state.vscdb',
    );
    return dbPath;
  } else { //if (defaultIDEMode === IDEMode.Cursor){
    const dbPath = path.join(
      homePath,
      'Library/Application Support/Cursor/User/globalStorage/state.vscdb',
    );
    return dbPath;
  }
}

export const readVSCodeOrCursorState = () => {
  const dbPath = IDEStateFilePath();

  try {
    console.time('read cursor state');

    const db = new Database(dbPath, { readonly: true });

    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('history.recentlyOpenedPathsList');


    if (row) {
      console.time('data to string');

      const binaryData = row.value;

      const jsonString = Buffer.from(binaryData).toString('utf-8');


      try {
        const jsonData = JSON.parse(jsonString);
        console.timeEnd('read cursor state'); 

        console.log('cursor state:', jsonData);
        return jsonData;
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

  return {};
};

/**
 * Delete a specific entry from Cursor's SQLite database
 * @param {string} entryToDelete - Path or workspace ID to delete
 * @param {boolean} isWorkspace - Whether it's a workspace (true) or folder (false)
 * @returns {boolean} - Whether deletion was successful
 */
async function deleteVSCodeOrCursorEntry(entryToDelete: string, isWorkspace = false) {
  // Build database path
  const dbPath = IDEStateFilePath(); //path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
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
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('history.recentlyOpenedPathsList');
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
      jsonData.entries = jsonData.entries.filter((entry:CursorSqliteEntry) => {
        // Keep entries without workspace property or with non-matching ID
        if (!entry.workspace) return true;
        
        // Compare workspace ID or configPath
        return !(
          entry.workspace.id === entryToDelete || 
          entry.workspace.configPath === entryToDelete
        );
      });
    } else {
      // Delete matching folder
      jsonData.entries = jsonData.entries.filter((entry:CursorSqliteEntry) => {
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
      'history.recentlyOpenedPathsList'
    );
    console.timeEnd('Write data');
    
    // Commit transaction
    db.prepare('COMMIT').run();
    
    console.log(`Successfully deleted project, reduced from ${originalLength} to ${jsonData.entries.length} entries`);
    return true;
    
  } catch (error) {
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


export const openVSCodeOrCursor = (path: string, ifForceReuseWin: boolean = false) => {
  let app: string; 
  let bundleId: string;

  if (defaultIDEMode === IDEMode.VSCode){
      app = 'vscode';
      bundleId = 'com.microsoft.VSCode'
  } else {
    app = 'cursor'
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

  exec(fullCmd, (error, stdout, stderr) => {
  });
};
