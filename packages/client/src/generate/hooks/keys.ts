import { companionHeader, manifestHashCheck } from '../companion.js';
import type { ClientModel } from '../model.js';
import { literal } from '../ts-type.js';
import { clientShapeHash } from './shape-hash.js';
import { DEFAULT_KEY_PREFIX, hookRoutes, varsParameter, type HookRoute } from './shared.js';

export interface KeysOptions {
  keyPrefix?: string;
  /** Import path of the runtime, default `@spinajs/client/runtime`. */
  moduleName?: string;
  /** File name of the client without extension, default `client`. */
  basename?: string;
  /** The routes from `hookRoutes`, when the caller has built them already. */
  hookRoutes?: HookRoute[];
}

// Only the names the key factories mention: the import is type-only, and an unused one would fail noUnusedLocals.
function typeImports(hooks: HookRoute[]): string[] {
  return [...new Set(hooks.filter((h) => h.route.kind === 'query').flatMap((h) => h.route.args.flatMap((a) => a.typeNames)))].sort();
}

type Segments = (...parts: string[]) => string;

// An infinite key sits under the route's own prefix, so `[prefix, controller, handler]` matches both caches of a route,
// but never equals a plain key: React Query must not share one entry between `useQuery` and `useInfiniteQuery`.
function keyEntry(hook: HookRoute, segments: Segments): string {
  const { controllerKey, name, kind } = hook.route;
  if (kind === 'mutation') return `    ${name}: [${segments(controllerKey, name)}] as const,`;
  const plain = `    ${name}: (${varsParameter(hook)}) => [${segments(controllerKey, name)}, vars] as const,`;
  const { infinite } = hook;
  if (!infinite) return plain;
  return `${plain}\n    ${infinite.keyName}: (${varsParameter(infinite)}) => [${segments(controllerKey, name, 'infinite')}, vars] as const,`;
}

/** `client.keys.ts`: query keys, cache tags, the error type and the shape hash. Server-safe: no React, no query library. */
export function emitKeys(model: ClientModel, options: KeysOptions = {}): string {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const hooks = options.hookRoutes ?? hookRoutes(model, { keyPrefix: prefix });
  const segments: Segments = (...parts) => [prefix, ...parts].map(literal).join(', ');
  const controllers = model.controllers.map((c) => ({ c, hooks: hooks.filter((h) => h.route.controllerKey === c.key) }));
  const keys = controllers.map(({ c, hooks: own }) => [`  ${c.key}: {`, `    all: [${segments(c.key)}] as const,`, ...own.map((h) => keyEntry(h, segments)), '  },'].join('\n'));
  const tags = controllers.map(({ c, hooks: own }) => {
    const entries = [['all', literal(`${prefix}:${c.key}`)], ...own.filter((h) => h.route.kind === 'query').map((h) => [h.route.name, literal(h.tags.route)])];
    return `  ${c.key}: { ${entries.map(([name, tag]) => `${name}: ${tag}`).join(', ')} },`;
  });
  const lines = [
    companionHeader('keys', model),
    `import type { ProblemError } from '${options.moduleName ?? '@spinajs/client/runtime'}';`,
    `import type { ${[...typeImports(hooks), 'manifestHash'].join(', ')} } from './${options.basename ?? 'client'}.js';`,
    '',
    ...manifestHashCheck(model),
    '',
    '/** A failed call: a problem reply from the server, or `TypeError` from fetch and `SyntaxError` from a malformed reply. */',
    'export type AppClientError = ProblemError | Error;',
    '',
    `export const appKeys = {\n  all: [${segments()}] as const,\n${keys.join('\n')}\n} as const;`,
    '',
    '/** Next.js cache tags, derived from the same names as `appKeys`. */',
    `export const appTags = {\n${tags.join('\n')}\n} as const;`,
    '',
    '/** Hash of every route name, argument name and reply schema; use it as a persisted-cache buster. */',
    `export const clientShapeHash = ${literal(clientShapeHash(model))};`,
  ];
  return `${lines.join('\n')}\n`;
}
