import { fileURLToPath } from 'node:url';

// The repository root has its own lockfile; without a root, Next would take the repository for the workspace.
const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  turbopack: { root },
  outputFileTracingRoot: root,
  // The generated files import each other as `./client.js`, which Next 16 resolves to `client.ts` only through this
  // webpack option; Turbopack ignores it, hence `next build --webpack`.
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
};
