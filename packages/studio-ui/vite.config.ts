import ckitStyles from '@coderush/ckit-styles/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const app = process.env.STUDIO_APP_ORIGIN ?? 'http://localhost:3000';
// The app's http.controllers.route.prefix as a path: unset for none, '/api' for 'api'.
const prefix = (process.env.STUDIO_APP_PREFIX ?? '').replace(/\/+$/, '');
const studioPath = `${prefix}/_studio`;

/** In development this server serves index.html, so it writes the two metas the Studio server writes into the built one. */
const devBaseMetas: Plugin = {
  name: 'studio-dev-base-metas',
  apply: 'serve',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'spina-studio-base', content: studioPath }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'spina-app-base', content: prefix }, injectTo: 'head' },
  ],
};

export default defineConfig(({ command }) => ({
  // S6 serves dist/ under any studio.path and injects <base href>, so built asset URLs stay relative.
  base: command === 'build' ? './' : `${studioPath}/`,
  plugins: [react(), ckitStyles(), devBaseMetas],
  resolve: {
    // ckit's dist imports these from the ckit checkout's node_modules; one copy each for the app and the kit.
    dedupe: ['react', 'react-dom', 'react-router', 'lucide-react', 'motion', '@tanstack/react-query'],
  },
  server: {
    port: 5180,
    proxy: { [`${studioPath}/api`]: app, [`${prefix}/telemetry`]: app, [`${prefix}/scheduler`]: app },
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
