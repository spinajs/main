import 'mocha';
import { expect } from 'chai';
import ts from 'typescript';
import sinon from 'sinon';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { ClassInfo } from '@spinajs/di';
import { DefaultControllerCache } from '../src/cache.js';
import type { IControllerDocumentation } from '../src/cache.js';
import type { BaseController } from '../src/base-controller.js';

const PACKAGES = resolve(process.cwd(), '..');

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.(d\.ts|ts|js)$/.test(name) ? [path] : [];
  });
}

// The authn-http and authz-http builds are what an app mounts next to http-swagger; they exist once the monorepo is built.
const FIXTURE_DIRS = [
  join(process.cwd(), 'test', 'controllers'),
  join(process.cwd(), 'test', 'policies'),
  join(PACKAGES, 'http-swagger', 'test', 'controllers'),
  join(PACKAGES, 'http-swagger', 'test', 'policies'),
  join(PACKAGES, 'authn-http', 'lib', 'mjs', 'v3', 'controllers'),
  join(PACKAGES, 'authn-http', 'lib', 'mjs', 'policies'),
  join(PACKAGES, 'authz-http', 'lib', 'mjs', 'controllers'),
];

const FILES = FIXTURE_DIRS.flatMap(sourcesUnder);
const isJs = (f: string) => f.endsWith('.js');

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeCache(): DefaultControllerCache {
  const cache = new DefaultControllerCache();
  Object.defineProperty(cache, 'Log', { value: noopLog });
  return cache;
}

/** Same options the extractors used when each call built its own `ts.Program`. */
function programParser(): (file: string) => ts.SourceFile | undefined {
  const declarations = ts.createProgram(FILES.filter((f) => !isJs(f)), {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.Latest,
    noResolve: true,
    skipLibCheck: true,
  });
  const scripts = ts.createProgram(FILES.filter(isJs), {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.Latest,
    noResolve: true,
    skipLibCheck: true,
  });
  return (file) => (isJs(file) ? scripts : declarations).getSourceFile(file);
}

function classNames(file: string): string[] {
  const sf = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest);
  return sf.statements.filter(ts.isClassDeclaration).flatMap((c) => (c.name ? [c.name.text] : []));
}

interface IPrivateExtractors {
  extractAll(file: string, className: string): { parameters: Record<string, string[]>; documentation: IControllerDocumentation };
  extractClassJsDoc(file: string, className: string): string | undefined;
  extractImports(file: string): Map<string, string>;
}

/** Everything the cache derives from one file: route parameters, documentation, imports, class JSDoc. */
function extractEverything(cache: DefaultControllerCache, file: string) {
  const c = cache as unknown as IPrivateExtractors;
  return classNames(file).map((name) => ({
    name,
    all: c.extractAll(file, name),
    classJsDoc: c.extractClassJsDoc(file, name),
    imports: isJs(file) ? [...c.extractImports(file)] : undefined,
  }));
}

describe('DefaultControllerCache source parsing', function () {
  this.timeout(60000);

  it('extracts exactly what the per-call ts.Program extraction did', () => {
    const reference = makeCache();
    Object.defineProperty(reference, 'parseSourceFile', { value: programParser() });
    const cache = makeCache();

    let documentedMethods = 0;
    for (const file of FILES) {
      const expected = extractEverything(reference, file);
      expect(JSON.stringify(extractEverything(cache, file)), file).to.equal(JSON.stringify(expected));
      documentedMethods += expected.reduce((n, e) => n + Object.keys(e.all.documentation.methods).length, 0);
    }

    // Guards against a vacuous pass: fixtures not found, or a parse that yields nothing on both sides.
    expect(FILES.length).to.be.greaterThan(20);
    expect(documentedMethods).to.be.greaterThan(20);
  });

  it('reads only the controller and its policy files, never the default lib or @types', async () => {
    const controller = join(PACKAGES, 'http-swagger', 'test', 'controllers', 'PolicyController.ts');
    const policies = join(PACKAGES, 'http-swagger', 'test', 'policies', 'TestPolicies.ts');
    const cache = makeCache();
    Object.defineProperty(cache, 'Hasher', { value: { hash: async () => 'deadbeef' } });
    const entries = new Map<string, string>();
    Object.defineProperty(cache, 'CacheFS', {
      value: {
        exists: async (key: string) => entries.has(key),
        write: async (key: string, data: string) => void entries.set(key, data),
        read: async (key: string) => Buffer.from(entries.get(key) ?? '{}'),
      },
    });
    const info = Object.assign(new ClassInfo<BaseController>(), { name: 'PolicyController', file: controller });

    const readFile = sinon.spy(ts.sys, 'readFile');
    let parameters: Record<string, string[]>;
    let policyDocs: Awaited<ReturnType<DefaultControllerCache['getPolicyDocumentation']>>;
    try {
      parameters = await cache.getCache(info);
      policyDocs = await cache.getPolicyDocumentation(info, ['AuthorizedTestPolicy', 'OffHoursTestPolicy']);
    } finally {
      readFile.restore();
    }

    expect(parameters).to.have.keys('inherited', 'combined', 'undocumented');
    expect(policyDocs.OffHoursTestPolicy.description).to.match(/^Allows requests only outside of business hours/);
    const reads = new Set(readFile.getCalls().map((call) => resolve(call.args[0])));
    expect([...reads].sort()).to.deep.equal([controller, policies].sort());
  });
});
