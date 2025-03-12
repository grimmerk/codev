import type { Configuration } from 'webpack';

import { plugins } from './webpack.plugins';
import { rules } from './webpack.rules';

rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      path: false,
      fs: false,
    },
  },
  // For Electron 28+, we need to use web instead of electron-renderer for security reasons
  // but need to provide node integration for compatibility
  target: 'web',
  // These are needed for webpack hot reloading to work with Electron's contextIsolation
  output: {
    publicPath: '/',
    globalObject: 'globalThis',
  },
  // Multiple entrypoints for different HTML pages
  entry: {
    switcher_window: './src/switcher-renderer.ts', // Updated to new file
    ai_assistant: './src/ai-assistant-renderer.ts',
    settings: './src/SettingsWindow.tsx',
  },
};
