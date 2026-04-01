import type { Configuration } from 'webpack';

export const preloadConfig: Configuration = {
  node: {
    __dirname: true,
    __filename: true,
  },
};
