import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ModuleDir {
  path(file: string): string;
  import<T>(file: string): Promise<T>;
  remove(): void;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Writes generated files as ES modules into a temporary directory, `.ts` transpiled to `.js`, with each import
 * specifier in `rewrite` replaced (a bare package by a file URL, or a generated file by a stub).
 */
export function writeModules(files: Record<string, string>, rewrite: Record<string, string> = {}): ModuleDir {
  const dir = mkdtempSync(join(tmpdir(), 'client-modules-'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  for (const [name, contents] of Object.entries(files)) {
    let js = name.endsWith('.ts') ? ts.transpileModule(contents, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText : contents;
    for (const [from, to] of Object.entries(rewrite)) js = js.replace(new RegExp(`from '${escape(from)}'`, 'g'), `from '${to}'`);
    writeFileSync(join(dir, name.replace(/\.ts$/, '.js')), js);
  }
  return {
    path: (file: string) => join(dir, file),
    import: <T>(file: string) => import(pathToFileURL(join(dir, file)).href) as Promise<T>,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** File URLs of the packages the generated hook files import, as `writeModules` rewrites take them. */
export function libraryUrls(specifiers: readonly string[]): Record<string, string> {
  return Object.fromEntries(specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]));
}

/**
 * Runs `load` while the files of npm alias `alias` that import `name` (or a subpath of it) get the alias instead:
 * swr-floor is swr 2.2.0, whose files import `swr/_internal`, and that import has to stay inside the floor copy.
 * `module.registerHooks` needs Node 22.15.
 */
export async function withAliasedImports<T>(alias: string, name: string, load: () => Promise<T>): Promise<T> {
  const own = new RegExp(`^${escape(name)}(/|$)`);
  const hooks = registerHooks({
    resolve: (specifier, context, next) => (context.parentURL?.includes(`/node_modules/${alias}/`) && own.test(specifier) ? next(specifier.replace(name, alias), context) : next(specifier, context)),
  });
  try {
    return await load();
  } finally {
    hooks.deregister();
  }
}

const GLOBALS = ['window', 'document', 'navigator'] as const;

export interface Dom {
  document: Document;
  restore(): void;
}

/** jsdom's `window`, `document` and `navigator` as globals; install it before loading SWR or a generated hook file. */
export function installDom(): Dom {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of GLOBALS) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  return {
    document: dom.window.document,
    restore: () => {
      for (const name of GLOBALS) {
        const descriptor = saved[name];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** For "nothing else happens": returns once `read()` has not changed for a whole quiet period. */
export async function quiet(read: () => unknown, period = 80): Promise<void> {
  let last = JSON.stringify(read());
  let since = Date.now();
  while (Date.now() - since < period) {
    await sleep(10);
    const now = JSON.stringify(read());
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}
