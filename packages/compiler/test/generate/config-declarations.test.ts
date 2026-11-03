import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, createProgramFromTsconfig, extractConfigModules, generateConfigDeclarations, generateConfigTypes, leafPaths } from '../../src/index.js';
import type { Manifest } from '@spinajs/manifest';

const manifestPath = fileURLToPath(new URL('../fixtures/app-basic/app.manifest.json', import.meta.url));
const snapshotPath = fileURLToPath(new URL('../__snapshots__/app-basic.config.d.ts', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

const withSchemas = (schemas: Record<string, unknown>, modules: { module: string; schemaId: string }[]): Manifest => ({ hash: 'h', configModules: modules, schemas }) as unknown as Manifest;

describe('generateConfigDeclarations', () => {
  it('flattens schemas into leaf and node paths', () => {
    const paths = leafPaths({ type: 'object', properties: { timeoutMs: { type: 'integer' }, nested: { type: 'object', properties: { a: { type: 'string' } } }, __file__: { type: 'string' } } }, 'hooks');
    expect(paths.map((p) => p.path)).to.deep.equal(['hooks.timeoutMs', 'hooks.nested', 'hooks.nested.a']);
  });

  it('matches the committed snapshot and declares app.name as string', async () => {
    const source = await generateConfigDeclarations(manifest);
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, source);
    expect(source).to.equal(readFileSync(snapshotPath, 'utf8'));
    expect(source).to.include(`'app.name': string;`);
    expect(source).to.match(/declare module '@spinajs\/configuration-common' \{\s+interface ConfigPaths \{/);
  });

  it('restricts to the requested modules and is deterministic', async () => {
    const only = await generateConfigDeclarations(manifest, { modules: ['app'] });
    expect(only).to.include(`'app.name': string;`);
    expect(await generateConfigDeclarations(manifest, { modules: ['app'] })).to.equal(only);
    expect(await generateConfigDeclarations(manifest, { modules: ['hooks'] })).to.not.include(`'app.name'`);
  });

  it('resolves a local #/definitions ref and a ref to another manifest schema id', async () => {
    const m = withSchemas(
      {
        'spinajs/x/other': { $id: 'spinajs/x/other', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        'spinajs/x/mod': {
          $id: 'spinajs/x/mod',
          type: 'object',
          definitions: { Mode: { enum: ['a', 'b'] } },
          properties: { mode: { $ref: '#/definitions/Mode' }, other: { $ref: 'spinajs/x/other' } },
        },
      },
      [{ module: 'mod', schemaId: 'spinajs/x/mod' }],
    );
    const { source, warnings } = await generateConfigTypes(m);
    expect(warnings).to.deep.equal([]);
    expect(source).to.include(`'mod.mode': 'a' | 'b';`);
    expect(source).to.match(/'mod\.other': \{ n: number/);
  });

  it('falls back to unknown with a warning when a ref cannot resolve', async () => {
    const m = withSchemas({ 'spinajs/x/mod': { type: 'object', properties: { bad: { $ref: 'spinajs/x/missing' } } } }, [{ module: 'mod', schemaId: 'spinajs/x/mod' }]);
    const { source, warnings } = await generateConfigTypes(m);
    expect(source).to.include(`'mod.bad': unknown;`);
    expect(warnings.some((w) => w.includes('mod.bad'))).to.equal(true);
  });

  it('is not confused by nested titles', async () => {
    const m = withSchemas({ s: { type: 'object', properties: { o: { title: 'Inner', type: 'object', properties: { a: { title: 'A', type: 'string' } } } } } }, [{ module: 'mod', schemaId: 's' }]);
    const { source } = await generateConfigTypes(m);
    expect(source).to.include(`'mod.o': { a?: string };`);
    expect(source).to.include(`'mod.o.a': string;`);
  });

  it('types an alternative it could not fully read as unknown, not as the members it read', async () => {
    const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
    const modules = extractConfigModules(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('config-literals.ts'))!);
    const { source } = await generateConfigTypes(withSchemas(ctx.schemas, modules));
    expect(source).to.include(`'unreadable.claim': unknown;`);
    expect(source).to.include(`'unreadable.some': unknown;`);
    expect(source).to.include(`'unreadable.kind': string;`);
  });

  it('leaves the objects of a partial schema open, since a member it could not read may add keys', async () => {
    const object = { type: 'object', properties: { subject: { type: 'string' } } };
    const m = withSchemas(
      {
        partial: { type: 'object', 'x-explicit': 'partial', properties: { claims: object } },
        whole: { type: 'object', properties: { claims: object } },
      },
      [
        { module: 'partial', schemaId: 'partial' },
        { module: 'whole', schemaId: 'whole' },
      ],
    );
    const { source } = await generateConfigTypes(m);
    expect(source).to.include(`'partial.claims': { subject?: string; [k: string]: unknown };`);
    expect(source).to.include(`'whole.claims': { subject?: string };`);
  });

  it('warns about requested modules that match nothing', async () => {
    const { warnings } = await generateConfigTypes(manifest, { modules: ['app', 'nope'] });
    expect(warnings).to.deep.equal([`config module 'nope' is not in the manifest`]);
  });
});
