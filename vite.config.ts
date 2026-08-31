import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@desktop-workspace/foundation': fileURLToPath(
        new URL('./packages/desktop-foundation/src/index.ts', import.meta.url)
      )
    }
  }
})
