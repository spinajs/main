import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expect = chai.expect;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'api-snapshot.mjs');

interface Change {
  status: string;
  path: string;
}

interface SnapshotTool {
  snapshotPackage(pkg: { dir: string; entries: readonly string[]; tsconfig?: string }): string;
  compareSnapshots(generated: Map<string, string>, committed: Map<string, string>): { ok: boolean; problems: string[] };
  rfcDecision(changes: readonly Change[], gateReached: boolean): { ok: boolean; snapshots: string[]; rfcs: string[]; message: string };
}

// A non-literal specifier keeps the .mjs out of the type checker, which has no declarations for it.
const loadTool = (): Promise<SnapshotTool> => import(pathToFileURL(SCRIPT).href) as Promise<SnapshotTool>;

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: '@fx/pkg', type: 'module' }),
  'tsconfig.mjs.json': JSON.stringify({
    compilerOptions: { rootDir: './src', outDir: './lib', module: 'node16', moduleResolution: 'node16', target: 'ES2021', lib: ['es2021'], types: [], strict: true, declaration: true, composite: true },
    include: ['src/**/*'],
  }),
  'src/api.ts': ["export * from './a.js';", "export type { Ext } from 'ext';", "export { extValue } from 'ext';", ''].join('\n'),
  'src/a.ts': ["import type { Mode } from './b.js';", '', '// helper: not exported, but Shape uses it', 'type Helper = { readonly k: number };', '', 'export interface Shape {', '  readonly id: string; // the id', '  readonly mode: Mode;', '  readonly helper: Helper;', '}', '', '/** Builds a shape. */', 'export function make(name: string): Shape {', "  return { id: name, mode: 'r', helper: { k: 1 } };", '}', ''].join('\n'),
  'src/b.ts': ["export type Mode = 'r' | 'w';", ''].join('\n'),
  'node_modules/ext/package.json': JSON.stringify({ name: 'ext', type: 'module', types: './index.d.ts' }),
  'node_modules/ext/index.d.ts': ['interface Hidden {', '  readonly x: number;', '}', 'export interface Ext {', '  readonly hidden: Hidden;', '}', 'export declare const extValue: number;', 'export {};', ''].join('\n'),
};

type Mutation = [file: string, from: string, to: string];

describe('API snapshot of the frozen contracts', function () {
  this.timeout(120_000);

  let tool: SnapshotTool;
  let tmp: string;
  let baseline: string;

  const snapshotOf = (mutations: readonly Mutation[] = []): string => {
    const dir = mkdtempSync(join(tmp, 'pkg-'));
    for (const [file, text] of Object.entries(BASE)) {
      let content = text;
      for (const [target, from, to] of mutations) {
        if (target !== file) continue;
        expect(content, `mutation ${from} -> ${to}`).to.include(from);
        content = content.split(from).join(to);
      }
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    return tool.snapshotPackage({ dir, entries: ['src/api.ts'], tsconfig: 'tsconfig.mjs.json' });
  };

  before(async () => {
    tool = await loadTool();
    tmp = mkdtempSync(join(tmpdir(), 'api-snapshot-'));
    baseline = snapshotOf();
  });

  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  describe('snapshot content', () => {
    it('holds the declarations of the entry closure and the external re-exports', () => {
      expect(baseline).to.include('## src/a.ts');
      expect(baseline).to.include('## src/b.ts');
      expect(baseline).to.include('## src/api.ts');
      expect(baseline).to.include('export interface Shape {');
      expect(baseline).to.include('export declare function make(name: string): Shape;');
      expect(baseline).to.include('export interface Ext {');
      expect(baseline).to.include('interface Hidden {');
      expect(baseline).to.include('export declare const extValue: number;');
      expect(baseline).not.to.include('the id');
      expect(baseline).not.to.include('Builds a shape');
      expect(baseline).not.to.include('\r');
    });

    it('is deterministic', () => {
      expect(snapshotOf()).to.eq(baseline);
    });
  });

  describe('changes that count', () => {
    const cases: Record<string, Mutation[]> = {
      'renaming an export': [['src/a.ts', 'Shape', 'Form']],
      'adding an export': [['src/a.ts', 'export function make', 'export type Extra = string;\nexport function make']],
      'removing an export': [['src/a.ts', 'export function make', 'function make']],
      'making a member optional': [['src/a.ts', 'readonly id: string', 'readonly id?: string']],
      'dropping readonly': [['src/a.ts', 'readonly mode: Mode', 'mode: Mode']],
      'changing a parameter type': [
        ['src/a.ts', 'make(name: string)', 'make(name: string | number)'],
        ['src/a.ts', 'id: name,', 'id: String(name),'],
      ],
      'changing a non-exported helper type': [
        ['src/a.ts', 'readonly k: number', 'readonly k: string'],
        ['src/a.ts', 'k: 1', "k: '1'"],
      ],
      'changing a type in a relatively imported file': [['src/b.ts', "'r' | 'w'", "'r' | 'w' | 'x'"]],
      'changing an externally re-exported type': [['node_modules/ext/index.d.ts', 'readonly hidden: Hidden', 'readonly hidden?: Hidden']],
      'changing a non-exported helper of an external type': [['node_modules/ext/index.d.ts', 'readonly x: number', 'readonly x: string']],
    };

    for (const [name, mutations] of Object.entries(cases)) {
      it(name, () => {
        expect(snapshotOf(mutations)).not.to.eq(baseline);
      });
    }
  });

  describe('changes that do not count', () => {
    const cases: Record<string, Mutation[]> = {
      'editing a comment': [
        ['src/a.ts', '// the id', '// the primary key, never reused'],
        ['src/a.ts', '/** Builds a shape. */', '/**\n * Builds a shape from a name.\n * @param name the id\n */'],
      ],
      'reformatting whitespace': [
        ['src/a.ts', 'type Helper = { readonly k: number };', 'type Helper = {\n  readonly k: number;\n};'],
        ['src/a.ts', 'make(name: string): Shape {', 'make(\n  name: string,\n): Shape\n{'],
        ['src/b.ts', "'r' | 'w'", "\n  | 'r'\n  | 'w'"],
      ],
      'changing a function body': [['src/a.ts', "return { id: name, mode: 'r', helper: { k: 1 } };", "const id = name.trim();\n  return { id, mode: 'w', helper: { k: 2 } };"]],
    };

    for (const [name, mutations] of Object.entries(cases)) {
      it(name, () => {
        expect(snapshotOf(mutations)).to.eq(baseline);
      });
    }
  });

  describe('compareSnapshots', () => {
    it('accepts identical sets and ignores CRLF in committed files', () => {
      const res = tool.compareSnapshots(new Map([['p/etc/p.api.md', 'a\nb\n']]), new Map([['p/etc/p.api.md', 'a\r\nb\r\n']]));
      expect(res).to.deep.eq({ ok: true, problems: [] });
    });

    it('reports missing, stale and extra files with the first differing lines', () => {
      const generated = new Map([
        ['a/etc/a.api.md', 'x\ny\n'],
        ['b/etc/b.api.md', 'one\ntwo\nthree\n'],
      ]);
      const committed = new Map([
        ['b/etc/b.api.md', 'one\nTWO\nthree\n'],
        ['c/etc/c.api.md', 'z\n'],
      ]);
      const res = tool.compareSnapshots(generated, committed);
      expect(res.ok).to.eq(false);
      const text = res.problems.join('\n');
      expect(text).to.match(/a\/etc\/a\.api\.md.*missing/);
      expect(text).to.match(/b\/etc\/b\.api\.md.*stale/);
      expect(text).to.include('line 2');
      expect(text).to.include('- TWO');
      expect(text).to.include('+ two');
      expect(text).to.match(/c\/etc\/c\.api\.md.*extra/);
    });
  });

  describe('rfcDecision', () => {
    const snapshot: Change = { status: 'M', path: 'packages/authz/etc/authz.api.md' };
    const rfc: Change = { status: 'A', path: 'docs/plans/authz-v3-rfc/L1-1.md' };
    const other: Change = { status: 'M', path: 'packages/authz/src/engine.ts' };

    const grid: [gate: boolean, snapshotChanged: boolean, rfcPresent: boolean, ok: boolean][] = [
      [false, false, false, true],
      [false, false, true, true],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, true],
      [true, false, true, true],
      [true, true, false, false],
      [true, true, true, true],
    ];

    for (const [gate, changed, present, ok] of grid) {
      it(`gate ${gate ? 'reached' : 'not reached'}, snapshot ${changed ? 'changed' : 'unchanged'}, RFC ${present ? 'present' : 'absent'} => ${ok ? 'pass' : 'fail'}`, () => {
        const changes = [other, ...(changed ? [snapshot] : []), ...(present ? [rfc] : [])];
        const res = tool.rfcDecision(changes, gate);
        expect(res.ok).to.eq(ok);
        if (!ok) expect(res.message).to.include('packages/authz/etc/authz.api.md');
      });
    }

    it('does not count a deleted RFC file', () => {
      const res = tool.rfcDecision([snapshot, { status: 'D', path: 'docs/plans/authz-v3-rfc/old.md' }], true);
      expect(res.ok).to.eq(false);
    });

    it('counts a deleted snapshot as a change', () => {
      const res = tool.rfcDecision([{ status: 'D', path: 'packages/authz-fs/etc/authz-fs.api.md' }], true);
      expect(res.ok).to.eq(false);
      expect(res.snapshots).to.deep.eq(['packages/authz-fs/etc/authz-fs.api.md']);
    });
  });

  describe('the repository', () => {
    it('matches the committed snapshots (--check)', () => {
      const res = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(res.status, `${res.stdout}\n${res.stderr}`).to.eq(0);
    });
  });
});
