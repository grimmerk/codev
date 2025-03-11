import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';

export const readCursorState = () => {
  const dbPath = path.join(
    os.homedir(),
    'Library/Application Support/Cursor/User/globalStorage/state.vscdb',
  );

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


export const openCursor = (path: string) => {

};