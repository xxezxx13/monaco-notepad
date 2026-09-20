import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          preferences: resolve(__dirname, 'src/renderer/preferences/preferences.html')
        }
      }
    }
  }
})
