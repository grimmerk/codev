import type { Configuration } from 'webpack';
import * as path from 'path';

import { rules } from './webpack.rules';

// Fix spawn-helper permissions after copy (copy-webpack-plugin strips execute bit)
class FixPermissionsPlugin {
  apply(compiler: any) {
    compiler.hooks.afterEmit.tap('FixPermissionsPlugin', () => {
      const fs = require('fs');
      const outputPath = compiler.outputPath;
      const helpers = [
        path.join(outputPath, 'node_modules/node-pty/build/Release/spawn-helper'),
        path.join(outputPath, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
        path.join(outputPath, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
      ];
      for (const h of helpers) {
        try { fs.chmodSync(h, 0o755); } catch {}
      }
    });
  }
}

export const mainConfig: Configuration = {
  // Add this for production builds
  mode: process.env.BUILD_TYPE === 'prod' ? 'production' : 'development',
  watchOptions: {
    ignored: /node_modules|\.claude/,
  },
  stats: {
    errorDetails: true,
  },
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/main.ts',
  // Put your normal webpack config below here
  module: {
    rules,
  },
  externals: [
    '@nestjs/microservices',
    '@nestjs/websockets',
    '@nestjs/websockets/socket-module',
    '@nestjs/microservices/microservices-module',
    'node-pty',
  ],
  plugins: [
    new (require('copy-webpack-plugin'))({
      patterns: [
        {
          from: 'node_modules/node-pty',
          to: 'node_modules/node-pty',
        },
      ],
    }),
    new FixPermissionsPlugin(),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      path: false,
      fs: false,
      child_process: false,
    },
  },
  // Node.js polyfills are no longer included by default in webpack 5
  target: 'electron-main',
};
