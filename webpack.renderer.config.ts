import type { Configuration } from 'webpack';

import { plugins } from './webpack.plugins';

const rendererRules = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
        configFile: process.env.BUILD_TYPE === 'prod' ? 'tsconfig.prod.json' : 'tsconfig.json',
      },
    },
  },
  {
    test: /\.css$/,
    use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
  },
];

export const rendererConfig: Configuration = {
  // Add this for production builds
  mode: process.env.BUILD_TYPE === 'prod' ? 'production' : 'development',
  watchOptions: {
    ignored: /node_modules|\.claude/,
  },
  module: {
    rules: rendererRules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    fallback: {
      path: false,
      fs: false,
    },
  },
  target: 'web',
  output: {
    globalObject: 'globalThis',
  },
  // Disable innerGraph to prevent webpack from incorrectly tree-shaking
  // xterm.js class hierarchy (webpack#17711, fixed in 5.90+)
  optimization: {
    innerGraph: false,
  },
};
