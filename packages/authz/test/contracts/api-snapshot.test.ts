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
  parseNameStatus(text: string): Change[];
  g1Reached(root: string): { reached: boolean; tagFound: boolean };
  findAugmentations(root: string, targets: { packages: Set<string>; files: Set<string> }, allowlist?: readonly string[]): string[];
  unconfiguredFrozenFiles(root: string, config: { packages: Record<string, readonly string[]>; pending?: readonly string[] }): string[];
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
  'src/a.ts': ["import type { Mode } from './b.js';", '', '// helper: not exported, but Shape uses it', 'type Helper = { readonly k: number };', '', 'export interface Shape {', '  readonly id: string; // the id', '  readonly mode: Mode;', '  readonly helper: Helper;', '}', '', '/** Builds a shape. */', 'export function make(name: string): Shape {', "  return { id: name, mode: 'r', helper: { k: 1 } };", '}', '', '// values count, function bodies do not', "const PREFIX = 'shape';", 'export const PATTERN: RegExp = new RegExp(`^${PREFIX}:[a-z]+$`);', 'export const LIMITS: readonly number[] = Object.freeze([1, 2]);', 'export const TABLE: Readonly<Record<string, number>> = Object.freeze({ a: 1, b: 2 });', 'export const twice = (n: number): number => n * 2;', 'export const tools = {', '  run(): number {', '    return 1;', '  },', '};', ''].join('\n'),
  'src/b.ts': ["export type Mode = 'r' | 'w';", ''].join('\n'),
  'node_modules/ext/package.json': JSON.stringify({ name: 'ext', type: 'module', types: './index.d.ts' }),
  'node_modules/ext/index.d.ts': ['interface Hidden {', '  readonly x: number;', '}', 'export interface Ext {', '  readonly hidden: Hidden;', '}', 'export declare const extValue: number;', 'export {};', '//# sourceMappingURL=index.d.ts.map', ''].join('\n'),
  'node_modules/ext/index.d.ts.map': JSON.stringify({ version: 3, file: 'index.d.ts', sourceRoot: '', sources: ['src/index.ts'], names: [], mappings: '' }),
  'node_modules/ext/src/index.ts': ['const BASE_VALUE = 1;', 'export const extValue: number = BASE_VALUE + 0;', ''].join('\n'),
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

  const writeTree = (root: string, files: Record<string, string>): void => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
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

    it('holds constant values but no function bodies', () => {
      expect(baseline).to.include('const PREFIX = "shape";');
      expect(baseline).to.include('const LIMITS = Object.freeze([');
      expect(baseline).to.include('const TABLE = Object.freeze({');
      expect(baseline).to.include('const tools = {');
      expect(baseline).to.include('const extValue = BASE_VALUE + 0;');
      expect(baseline).to.include('const BASE_VALUE = 1;');
      expect(baseline).not.to.include('const twice =');
      expect(baseline).not.to.include('return 1');
      expect(baseline).not.to.include('values count');
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
      'changing a frozen constant value': [['src/a.ts', '[1, 2]', '[1, 3]']],
      'changing a key of a frozen object': [['src/a.ts', '{ a: 1, b: 2 }', '{ a: 1, c: 2 }']],
      'changing a non-exported constant an exported one uses': [['src/a.ts', "PREFIX = 'shape'", "PREFIX = 'form'"]],
      'changing an externally re-exported constant value': [['node_modules/ext/src/index.ts', 'BASE_VALUE + 0', 'BASE_VALUE + 1']],
      'changing a constant of the external source that a re-exported one uses': [['node_modules/ext/src/index.ts', 'BASE_VALUE = 1', 'BASE_VALUE = 2']],
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
      'changing the body of a function-valued constant': [['src/a.ts', 'n * 2', 'n + n']],
      'changing a method body inside a constant': [['src/a.ts', 'return 1;', 'return 0 + 1;']],
      'reformatting a constant value': [
        ['src/a.ts', 'Object.freeze([1, 2])', 'Object.freeze([\n  1,\n  2,\n])'],
        ['src/a.ts', 'Object.freeze({ a: 1, b: 2 })', 'Object.freeze({\n  a: 1,\n  b: 2,\n})'],
        ['src/a.ts', "'shape'", '"shape"'],
      ],
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

    it('counts only <lane>-<n>.md files as RFCs', () => {
      for (const path of ['docs/plans/authz-v3-rfc/.gitkeep', 'docs/plans/authz-v3-rfc/notes.md', 'docs/plans/authz-v3-rfc/sub/L1-1.md', 'docs/plans/authz-v3-rfc/L1-x.md']) {
        expect(tool.rfcDecision([snapshot, { status: 'A', path }], true).ok, path).to.eq(false);
      }
      expect(tool.rfcDecision([snapshot, { status: 'M', path: 'docs/plans/authz-v3-rfc/SEC1-12.md' }], true).ok).to.eq(true);
    });

    it('does not count a deleted RFC file', () => {
      const res = tool.rfcDecision([snapshot, { status: 'D', path: 'docs/plans/authz-v3-rfc/L2-3.md' }], true);
      expect(res.ok).to.eq(false);
    });

    it('counts a deleted snapshot as a change', () => {
      const res = tool.rfcDecision([{ status: 'D', path: 'packages/authz-fs/etc/authz-fs.api.md' }], true);
      expect(res.ok).to.eq(false);
      expect(res.snapshots).to.deep.eq(['packages/authz-fs/etc/authz-fs.api.md']);
    });
  });

  describe('parseNameStatus', () => {
    it('reads git diff --name-status output', () => {
      expect(tool.parseNameStatus('M\tpackages/a/etc/a.api.md\nA\tdocs/plans/authz-v3-rfc/L1-1.md\r\nD\told file.ts\n\n')).to.deep.eq([
        { status: 'M', path: 'packages/a/etc/a.api.md' },
        { status: 'A', path: 'docs/plans/authz-v3-rfc/L1-1.md' },
        { status: 'D', path: 'old file.ts' },
      ]);
    });
  });

  describe('g1Reached', () => {
    const git = (cwd: string, ...args: string[]): void => {
      const res = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
      expect(res.status, res.stderr).to.eq(0);
    };

    it('needs the tag and its ancestry', () => {
      const repo = mkdtempSync(join(tmp, 'git-'));
      git(repo, 'init', '-q');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'a');
      expect(tool.g1Reached(repo)).to.deep.eq({ reached: false, tagFound: false });
      git(repo, 'tag', 'authz-v3-g1');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'b');
      expect(tool.g1Reached(repo)).to.deep.eq({ reached: true, tagFound: true });
      git(repo, 'checkout', '-q', '--orphan', 'other');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'c');
      expect(tool.g1Reached(repo)).to.deep.eq({ reached: false, tagFound: true });
    });
  });

  describe('findAugmentations', () => {
    it('reports declare module blocks that target a snapshotted package or file', () => {
      const root = mkdtempSync(join(tmp, 'aug-'));
      const block = (target: string): string => `declare module '${target}' {\n  interface Shape { extra?: string }\n}\nexport {};\n`;
      writeTree(root, {
        'packages/fx/src/a.ts': 'export interface Shape { readonly id: string }\n',
        'packages/fx/src/engine.ts': block('./a.js'),
        'packages/lane/src/x.ts': block('@fx/pkg'),
        'packages/lane/src/deep/sub.ts': block('@fx/pkg/sub'),
        'packages/lane/src/other.ts': block('@spinajs/http'),
        'packages/lane/src/near.ts': block('@fx/pkg-other'),
        'packages/lane/src/global.ts': 'declare global {\n  interface Window { w?: number }\n}\nexport {};\n',
        'packages/lane/src/allowed.ts': block('@fx/pkg'),
        'packages/lane/lib/built.d.ts': block('@fx/pkg'),
      });
      const found = tool.findAugmentations(root, { packages: new Set(['@fx/pkg']), files: new Set(['packages/fx/src/a.ts']) }, ['packages/lane/src/allowed.ts']);
      expect(found.map((f) => f.split(':')[0])).to.deep.eq(['packages/fx/src/engine.ts', 'packages/lane/src/deep/sub.ts', 'packages/lane/src/x.ts']);
    });
  });

  describe('unconfiguredFrozenFiles', () => {
    it('reports frozen-pattern files of authz and authn packages that no entry or pending item covers', () => {
      const root = mkdtempSync(join(tmp, 'frozen-'));
      const files = ['packages/authz-x/src/contracts.ts', 'packages/authn-y/src/api.ts', 'packages/authn/src/contracts/index.ts', 'packages/other/src/api.ts', 'packages/authz-z/src/index.ts'];
      writeTree(root, Object.fromEntries(files.map((f) => [f, 'export {};\n'])));
      const config = { packages: { 'authz-x': ['src/contracts.ts'] }, pending: ['packages/authn/src/contracts/index.ts'] };
      expect(tool.unconfiguredFrozenFiles(root, config)).to.deep.eq(['packages/authn-y/src/api.ts']);
    });
  });

  describe('the command line', () => {
    it('exits 2 on usage errors', () => {
      for (const args of [['--bogus'], ['--check-rfc']]) {
        const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
        expect(res.status, args.join(' ')).to.eq(2);
      }
    });
  });

  describe('the repository', () => {
    it('matches the committed snapshots (--check)', () => {
      const res = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(res.status, `${res.stdout}\n${res.stderr}`).to.eq(0);
    });
  });
});
