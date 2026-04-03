import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron';
import { DBPathMigrationManager, isUnPackaged } from './DBPathMigrationManager';
const path = require('path');

export function isMAS() {
  return process.mas || false;
}

export const isMasStr = isMAS() ? 'mas' : 'nonMas';

// ref:
// https://blog.logrocket.com/building-a-menu-bar-application-with-electron-and-react/
export interface ShortcutSettings {
  quickSwitcher: string;
  aiInsight: string;
  aiChat: string;
}

export class TrayGenerator {
  tray: Tray;
  attachedWindow: BrowserWindow;
  onTrayClickCallback: any;
  title: string;
  shortcuts: ShortcutSettings = {
    quickSwitcher: 'Command+Control+R',
    aiInsight: 'Command+Control+E',
    aiChat: 'Command+Control+C',
  };

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

  updateShortcuts = (shortcuts: ShortcutSettings) => {
    this.shortcuts = shortcuts;
  };

  private acceleratorToMenuLabel = (acc: string): string => {
    return acc.replace(/Command/g, 'Cmd').replace(/Control/g, 'Ctrl');
  };

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
      {
        label: 'IDE Preference',
        click: () => {
          this.openIDESettings();
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
          { label: `${this.acceleratorToMenuLabel(this.shortcuts.quickSwitcher)}: Open CodeV Quick Switcher`, enabled: false },
          { label: 'Tab: Switch Projects / Sessions', enabled: false },
          { label: `${this.acceleratorToMenuLabel(this.shortcuts.aiInsight)}: AI Assistant Insight`, enabled: false },
          { label: `${this.acceleratorToMenuLabel(this.shortcuts.aiChat)}: AI Assistant Smart Chat`, enabled: false },
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

  openIDESettings = () => {
    // Send IPC event to open IDE preference settings
    const { ipcMain } = require('electron');
    ipcMain.emit('open-ide-settings');
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

    const error = DBPathMigrationManager.migrateError;
    let info = '';
    if (!isMasStr) {
      info = `${isMasStr};db:${DBPathMigrationManager.databaseFilePath};schema:${DBPathMigrationManager.schemaPath};server:${DBPathMigrationManager.serverFolderPath};prismaPath:${DBPathMigrationManager.prismaPath};appPath:${appPath};info.${error}`;
      info = `CodeV app.i:${info}`;
    } else {
      info = 'CodeV';
    }

    this.tray = new Tray(icon);

    this.tray.setToolTip(`${info}`);
    this.tray.setTitle(title);

    this.tray.on('click', this.onTrayClick);
    this.tray.on('right-click', this.rightClickMenu);
  };
}
