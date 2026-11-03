import nodeModule from 'node:module';

// enableCompileCache came in Node 22.1, the engines range starts at 22.0, and this package builds against older types.
const enable = Reflect.get(nodeModule, 'enableCompileCache') as (() => unknown) | undefined;

/**
 * Turns on Node's compile cache for every module loaded after this call. It lives in `NODE_COMPILE_CACHE`, else
 * `<os temp dir>/node-compile-cache`; `NODE_DISABLE_COMPILE_CACHE=1` turns it off. A dir that cannot be written, as in a
 * read-only container, leaves it off without a word. Node writes it when the process exits, `process.exit()` included.
 */
export function enableCompileCache(): void {
  enable?.();
}
