import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Vitest 5 changed this default to true ("Vitest calls vi.clearAllMocks()
    // before every test", vitest.dev/guide/migration). Pinned to the v4
    // behaviour so the upgrade changes no test's semantics; the 21 files that
    // want a clean slate already clear their own mocks in beforeEach.
    clearMocks: false,
  },
  resolve: {
    alias: {
      // An ES module (.mts) so Vite's native config loader can read it; the
      // CommonJS-loaded .ts form is what a future Vite major stops supporting.
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
