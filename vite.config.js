import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __piBotDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/lib/pi-bot')

// Virtual "pi-bot:<rel>" modules: read the real .py/.sh/.txt files from
// src/lib/pi-bot/ at build time and return their content as a string export.
// This keeps the repo files as the single source of truth (deployed by /sync)
// without Vite trying to parse Python as JavaScript (which breaks ?raw here).
function piBotRaw() {
  return {
    name: 'pi-bot-raw',
    enforce: 'pre',
    resolveId(id) { if (id.startsWith('pi-bot:')) return id },
    load(id) {
      if (!id.startsWith('pi-bot:')) return
      const rel = id.slice('pi-bot:'.length)
      const full = path.resolve(__piBotDir, rel)
      return `export default ${JSON.stringify(fs.readFileSync(full, 'utf-8'))}`
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  plugins: [
    base44({
      // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
      // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
      hmrNotifier: true,
      navigationNotifier: true,
      analyticsTracker: true,
      visualEditAgent: true
    }),
    react(),
    piBotRaw(),
  ]
});