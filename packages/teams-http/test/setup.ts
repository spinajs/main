import { DI } from '@spinajs/di';

// Config sources pick lib/mjs or lib/cjs on their first resolve; a lib/cjs config file loads a
// second, CommonJS copy of @spinajs/di, whose Array.ofType resolves nothing (see http's test/setup.ts).
DI.setESMModuleSupport();
