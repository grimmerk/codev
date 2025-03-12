import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';
import { DBManager, isUnPackaged } from './DBManager';
const path = require('path');

export function isMAS() {
  return process.mas || false;
}

export const isMasStr = isMAS() ? 'mas' : 'nonMas';

// ref:
// https://blog.logrocket.com/building-a-menu-bar-application-with-electron-and-react/
export class TrayGenerator {
  tray: Tray;
  attachedWindow: BrowserWindow;
  onTrayClickCallback: any;
  title: string;

  constructor(
    attachedWindow: BrowserWindow,
    title: string,
    onTrayClickCallback: any,
  ) {
    this.tray = null;
    this.attachedWindow = attachedWindow;
    this.onTrayClickCallback = onTrayClickCallback;

    this.createTray(title);
  }

  onTrayClick = () => {
    if (this.onTrayClickCallback) {
      this.onTrayClickCallback();
    }
  };

  rightClickMenu = () => {
    const settingsItems = [
      {
        label: 'AI Assistant Settings',
        click: () => {
          this.openAIAssistantSettings();
        },
      },
      {
        label: 'API Key Settings',
        click: () => {
          this.openApiKeySettings();
        },
      },
      {
        label: 'Left-Click Behavior',
        click: () => {
          this.openLeftClickSettings();
        },
      },
    ];

    const menu: any = [
      {
        label: 'Settings',
        submenu: settingsItems,
      },
      { type: 'separator' },
      {
        label: 'Keyboard Shortcuts',
        submenu: [
          { label: 'Cmd+Ctrl+R: Open CodeV Quick Switcher', enabled: false },
          { label: 'Cmd+Ctrl+E: AI Assistant Insight', enabled: false },
          { label: 'Cmd+Ctrl+C: AI Assistant Smart Chat', enabled: false },
        ],
      },
      { type: 'separator' },
      {
        role: 'quit',
        accelerator: 'Command+Q',
      },
    ];

    this.tray.popUpContextMenu(Menu.buildFromTemplate(menu));
  };

  openAIAssistantSettings = () => {
    // Send IPC event to open the settings window
    const { ipcMain } = require('electron');
    ipcMain.emit('open-ai-assistant-settings');
  };

  openApiKeySettings = () => {
    // Send IPC event to open the API key settings
    const { ipcMain } = require('electron');
    ipcMain.emit('open-api-key-settings');
  };

  openLeftClickSettings = () => {
    // Send IPC event to open left-click behavior settings
    const { ipcMain } = require('electron');
    ipcMain.emit('open-left-click-settings');
  };

  // ref: https://www.electronjs.org/docs/latest/tutorial/tray
  createTray = (title: string) => {
    let icon: Electron.NativeImage;
    if (isUnPackaged) {
      icon = nativeImage.createFromPath('images/MenuBar.png');
    } else {
      const resoucePath = path.resolve(`${app.getAppPath()}/../`);
      icon = nativeImage.createFromPath(`${resoucePath}/MenuBar.png`);
    }

    const appPath = app.getAppPath();

    const error = DBManager.migrateError;
    let info = '';
    if (!isMasStr) {
      info = `${isMasStr};db:${DBManager.databaseFilePath};schema:${DBManager.schemaPath};server:${DBManager.serverFolderPath};prismaPath:${DBManager.prismaPath};appPath:${appPath};info.${error}`;
      info = `XWin app.i:${info}`;
    } else {
      info = 'SwitchV';
    }

    this.tray = new Tray(icon);

    this.tray.setToolTip(`${info}`);
    this.tray.setTitle(title);

    this.tray.on('click', this.onTrayClick);
    this.tray.on('right-click', this.rightClickMenu);
  };
}
