import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';

export const mainConfig: Configuration = {
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
    'rxjs/add/observable/fromEvent',
    'rxjs/Observable',
    'swagger-ui-express',
    'class-validator',
    'class-transformer'
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      path: false,
      fs: false,
      child_process: false
    }
  },
  // Node.js polyfills are no longer included by default in webpack 5
  target: 'electron-main',
};
