import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // Next keeps jsx: 'preserve' in tsconfig; tests render components with react-dom/server.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
  },
});
