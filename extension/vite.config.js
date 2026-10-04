import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./public/manifest.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  build: { target: 'chrome120', assetsInlineLimit: 0, chunkSizeWarningLimit: 1200 },
  preview: { headers: { 'Content-Security-Policy': manifest.content_security_policy.extension_pages } },
});
