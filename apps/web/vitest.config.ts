import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Shim Next's `server-only` marker so server-side lib modules
      // (e.g. `src/lib/research.ts`) can be unit-tested under vitest.
      'server-only': path.resolve(__dirname, 'test/shims/server-only.ts'),
    },
  },
});
