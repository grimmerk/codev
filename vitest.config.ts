import { defineConfig } from 'vitest/config';

// Scoped to *.test.ts so Vitest never has to load the Electron/webpack entry
// points (which pull in native modules and JSX). Node environment — the units
// under test are pure Node logic (fs/os/path).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
