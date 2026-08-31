import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('.', import.meta.url))
const bundledDeps = ['@desktop-workspace/foundation']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'electron/main.ts')
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledDeps })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'electron/preload.ts')
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root,
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(root, 'src'),
        '@desktop-workspace/foundation': resolve(root, 'packages/desktop-foundation/src/index.ts')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'index.html')
        }
      }
    }
  }
})
