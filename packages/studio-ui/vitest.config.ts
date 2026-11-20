import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// lucide-react's `exports` puts its CommonJS `node` build before `import`, and that build's require('react') reaches
// the root React 18; the ESM build sits next to it.
const lucideEsm = fileURLToPath(new URL('../esm/lucide-react.mjs', pathToFileURL(createRequire(import.meta.url).resolve('lucide-react'))));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Testing Library's `main` is CommonJS, which Vite cannot inline; its `module` build can be.
    mainFields: ['module', 'main'],
    dedupe: ['react', 'react-dom', 'react-router', 'lucide-react', 'motion', '@tanstack/react-query'],
    alias: [{ find: /^lucide-react$/, replacement: lucideEsm }],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    unstubGlobals: true,
    // Through Vite, not Node: only then does `dedupe` keep ckit on the app's React ("Invalid hook call" otherwise).
    // The root node_modules holds React 18 for another workspace, and these packages are hoisted next to it, so they
    // go through Vite as well (src/test/single-react.test.tsx).
    server: { deps: { inline: [/@coderush\//, /@tanstack\//, /@testing-library\//, /lucide-react/, /motion/, /framer-motion/] } },
  },
});
