import { app } from 'electron';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { isDebug } from './utility';
// TODO: use async version later
import { fork } from 'child_process';

// ref:
// https://www.prisma.io/docs/concepts/components/prisma-schema#prisma-schema-file-location schema file path:
// https://github.com/prisma/prisma/issues/9613 electron
// https://github.com/prisma/prisma/issues/4703#issuecomment-1162417399 programmatic access to CLI

export const isUnPackaged =
  process?.env?.NODE_ENV === 'development' ||
  process?.env?.DEBUG_PROD === 'true';

const dbFileName = 'dev.db';
// app.getPath() ~/git/xwin/electron in dev mode. production: resources/app/ xx some webpack folder
const appDataPath = app.getPath('userData'); // e.g. '~/Library/Application Support/Xwin'
const dbUsedVersionTxtPath = `${appDataPath}/dbUsedVersion.txt`;
export const sqlitePathInProd = `${appDataPath}/${dbFileName}`;
export const schemeCopyPathInProd = `${appDataPath}/schema.prisma`;

async function prisma(...args: any[]) {
  const command = `${DBPathMigrationManager.prismaPath}`;
  DBPathMigrationManager.migrateError += `;cmd:${command};`;

  if (isDebug) {
    console.log(`Running \`prisma ${args.join(' ')}\``);
    console.log({ cmd: command });
  }

  const env = { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin` };

  const child = fork(command, args, { env });
}

/** NOTE: only use for packaged app */
export class DBPathMigrationManager {
  static databaseFilePath = '';
  static schemaPath = '';
  static serverFolderPath = '';
  static needUpdate = false;
  static migrateError = '';
  static prismaPath = '';
  static migrateExePath = '';

  static fmtExePath = '';
  static queryExePath = '';
  static introspectionExePath = '';

  static initPath() {
    /** TODO: remove it since this check seems to be not needed */
    if (DBPathMigrationManager.serverFolderPath) {
      // already init
      return;
    }

    if (isUnPackaged) {
      // it is a file path in dev mode, but after webpack bundles in production, it is just some string, e.g. 4569
      DBPathMigrationManager.prismaPath = require.resolve('prisma');
      DBPathMigrationManager.serverFolderPath =
        path.resolve(`./`); /** not directly used */
      DBPathMigrationManager.schemaPath = `${DBPathMigrationManager.serverFolderPath}/prisma/schema.prisma`;

      DBPathMigrationManager.databaseFilePath = path.resolve(
        `${process.cwd()}/prisma/dev.db`,
      );

      /** embed nestjs version: not really used. intel version needs different file name*/
      DBPathMigrationManager.introspectionExePath = `./node_modules/@prisma/engines/introspection-engine-darwin-arm64`;
      DBPathMigrationManager.fmtExePath = `./node_modules/@prisma/engines/prisma-fmt-darwin-arm64`;
      DBPathMigrationManager.queryExePath = `./node_modules/@prisma/engines/libquery_engine-darwin-arm64.dylib.node`;
    } else {
      // **/Resources/
      const resourcePath = path.resolve(`${app.getAppPath()}/../`);
      DBPathMigrationManager.schemaPath = `${resourcePath}/app/.webpack/main/schema.prisma`;

      DBPathMigrationManager.databaseFilePath = sqlitePathInProd;

      /** mainly it requires two files
       * 1. node_modules/prisma/build/index.js
       * 2. node_modules/prisma/package.json
       * with these structure ./index.js & ../package.json
       * */
      DBPathMigrationManager.prismaPath = `${resourcePath}/prisma/build/index.js`;
      DBPathMigrationManager.migrateExePath = `${resourcePath}/migration-engine-darwin`;
      DBPathMigrationManager.introspectionExePath = `${resourcePath}/introspection-engine-darwin`;
      DBPathMigrationManager.fmtExePath = `${resourcePath}/prisma-fmt-darwin`;
      DBPathMigrationManager.queryExePath = `${resourcePath}/prisma/libquery_engine-darwin-arm64.dylib.node`;
    }
  }

  static async dbMigration() {
    process.env.DATABASE_URL = `file:${DBPathMigrationManager.databaseFilePath}`;

    /** !isUnPackaged */
    if (DBPathMigrationManager.migrateExePath) {
      /** For migration, it also requires
       * 1. node_modules/@prisma/engines/dist !!!!!
       * 2. node_modules/@prisma/engines/package.json
       * node_modules (<- folder structure required) should not be in some folder deeper than resources/
       * but if it is outside /resources, not suitable for packaging
       */

      process.env.PRISMA_MIGRATION_ENGINE_BINARY =
        DBPathMigrationManager.migrateExePath;

      process.env.PRISMA_INTROSPECTION_ENGINE_BINARY =
        DBPathMigrationManager.introspectionExePath;
      process.env.PRISMA_FMT_BINARY = DBPathMigrationManager.fmtExePath;
      process.env.PRISMA_QUERY_ENGINE_BINARY =
        DBPathMigrationManager.queryExePath;
      process.env.PRISMA_QUERY_ENGINE_LIBRARY =
        DBPathMigrationManager.queryExePath;

      /** NOTE: copy schema file to app.getPath('userData')
       * DBManager.schemaPath to schemeCopyPathInProd
       */
      copyFileSync(DBPathMigrationManager.schemaPath, schemeCopyPathInProd);
      DBPathMigrationManager.schemaPath = schemeCopyPathInProd;
    }

    try {
      await prisma(
        'migrate',
        'dev',
        '--name',
        'init',
        `--schema=${DBPathMigrationManager.schemaPath}`,
        '--skip-generate',
      );
    } catch (err) {
      DBPathMigrationManager.migrateError =
        DBPathMigrationManager.migrateError + err;

      if (isDebug) {
        console.log({ err });
      }
    }

    if (DBPathMigrationManager.migrateExePath) {
      /**
       * Preventive reset to avoid potential side effects.
       * No issues have been observed so far, and theoretically, not resetting should be fine.
       * However, this is done as a precaution to maintain the previous behavior.
       */
      process.env.PRISMA_INTROSPECTION_ENGINE_BINARY = '';
      process.env.PRISMA_FMT_BINARY = '';
      process.env.PRISMA_QUERY_ENGINE_BINARY = '';
      process.env.PRISMA_QUERY_ENGINE_LIBRARY = '';
    }
  }

  static getUsedVersion(): string {
    if (!existsSync(dbUsedVersionTxtPath)) {
      return;
    }
    try {
      const data = readFileSync(dbUsedVersionTxtPath, 'utf8');
      return data;
    } catch (err) {
      console.error(err);
      return;
    }
  }
  static updateUsedVersion(ver: string) {
    try {
      writeFileSync(dbUsedVersionTxtPath, ver);
    } catch (err) {
      console.error(err);
      return;
    }
  }

  static async doMigrationToVersion(ver: string) {
    await DBPathMigrationManager.dbMigration();
    DBPathMigrationManager.updateUsedVersion(ver);
  }

  static async checkNeedMigration(): Promise<string> {
    this.initPath();
    const dbVersion = DBPathMigrationManager.getUsedVersion();
    const schemaPackageVersion = app.getVersion();

    if (isDebug) {
      console.log(
        'db databaseFilePath:',
        DBPathMigrationManager.databaseFilePath,
      );
    }

    if (existsSync(DBPathMigrationManager.databaseFilePath)) {
      if (dbVersion !== schemaPackageVersion) {
        DBPathMigrationManager.needUpdate = true;
        return schemaPackageVersion;
      } else {
        if (isDebug) {
          console.log('db file exist and version is same');
        }
      }
    } else {
      DBPathMigrationManager.needUpdate = true;
      return schemaPackageVersion;
    }
  }
}
