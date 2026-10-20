import { DI } from '@spinajs/di';

// Loaded by `.mocharc.json` before every suite. Config sources fix their glob (`lib/cjs/config`
// or `lib/mjs/config`) from this flag on first resolve. A suite that resolved Configuration
// before ESM mode was on left them on `lib/cjs`; in a tree where `lib/cjs` is CommonJS
// (`prepare-module-support`), those files load a second, CJS copy of @spinajs/di whose global
// `Array.ofType` makes every later `Array.ofType(...)` resolve come back empty.
DI.setESMModuleSupport();
