import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Testing Library's `main` is CommonJS, which Vite cannot inline; its `module` build can be.
    mainFields: ['module', 'main'],
    dedupe: ['react', 'react-dom', 'react-router', 'lucide-react', 'motion', '@tanstack/react-query'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    unstubGlobals: true,
    // Through Vite, not Node: only then does `dedupe` keep ckit on the app's React ("Invalid hook call" otherwise).
    // The root node_modules holds React 18 for another workspace, and React Query and Testing Library are hoisted
    // next to it, so they go through Vite as well.
    server: { deps: { inline: [/@coderush\//, /@tanstack\//, /@testing-library\//] } },
  },
});
