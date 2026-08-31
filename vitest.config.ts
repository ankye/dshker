import { fileURLToPath, URL } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/tests/setup.ts'],
    globals: true,
    include: [
      'src/**/*.test.ts',
      'electron/**/*.test.ts',
      'packages/**/*.test.ts',
      'tools/**/*.test.mjs'
    ],
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
    // The Git mirror, worktree, and bundled-seed suites drive a real `git`
    // binary against on-disk fixtures. Each finishes in a few seconds alone, but
    // under full-suite concurrency they exceed the 5s default. The timeout
    // reflects the cost of real process work rather than leaving those suites to
    // fail depending on scheduling.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      include: [
        'src/**/*.{ts,vue}',
        'packages/**/*.{ts,vue}',
        'service/node/**/*.mjs',
        'electron/**/*.ts',
        'tools/**/*.mjs'
      ],
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        '**/*.test.*',
        '**/*.e2e.test.*',
        'dist/**',
        'dist-web/**',
        'out/**',
        'release/**',
        '.run/**',
        '.runlogs/**',
        'node_modules/**'
      ]
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@desktop-workspace/foundation': fileURLToPath(
        new URL('./packages/desktop-foundation/src/index.ts', import.meta.url)
      )
    }
  }
})
