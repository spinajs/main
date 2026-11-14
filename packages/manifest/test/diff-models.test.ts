import { expect } from 'chai';
import 'mocha';
import { diffManifest, mergeFragments, renderMarkdown } from '../src/index.js';
import type { Change, Manifest, ModelColumn, ModelEntry } from '../src/index.js';
import { fragment, src } from './support.js';

const meta = { app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '2026-11-03T00:00:00.000Z' };
const col = (name: string, over: Partial<ModelColumn> = {}): ModelColumn => ({ name, type: { text: 'string' }, primary: false, nullable: false, sql: { family: 'text', inferred: true }, ...over });
const model = (className: string, tableName: string, columns: ModelColumn[], over: Partial<ModelEntry> = {}): ModelEntry => ({ id: className, className, tableName, columns, relations: [], accessResource: false, source: src('app'), ...over });
const manifest = (...models: ModelEntry[]): Manifest => mergeFragments(fragment('app', { models }), [], meta);
const modelChanges = (base: Manifest, head: Manifest): Change[] => diffManifest(base, head).changes.filter((c) => c.section === 'models');

describe('diffManifest models', () => {
  it('reports nothing for the same models', () => {
    expect(modelChanges(manifest(model('User', 'users', [col('Id')])), manifest(model('User', 'users', [col('Id')])))).to.deep.equal([]);
  });

  it('a base written before SQL specs is not a change', () => {
    expect(modelChanges(manifest(model('User', 'users', [col('Id', { sql: undefined })])), manifest(model('User', 'users', [col('Id')])))).to.deep.equal([]);
  });

  it('a removed table is breaking, an added one is not', () => {
    const base = manifest(model('User', 'users', [col('Id')]), model('Log', 'logs', [col('Id')]));
    const head = manifest(model('User', 'users', [col('Id')]), model('Post', 'posts', [col('Id')]));
    expect(modelChanges(base, head)).to.deep.equal([
      { section: 'models', kind: 'removed', id: 'default:logs', breaking: true },
      { section: 'models', kind: 'added', id: 'default:posts', breaking: false },
    ]);
  });

  it('a removed column is breaking, an added one is not', () => {
    const changes = modelChanges(manifest(model('User', 'users', [col('Id'), col('Email')])), manifest(model('User', 'users', [col('Id'), col('Name', { nullable: true }), col('Login')])));
    expect(changes).to.deep.equal([{ section: 'models', kind: 'changed', id: 'default:users', breaking: true, detail: 'column Email removed; column Name added; column Login added (NOT NULL)' }]);
  });

  it('NOT NULL is breaking, nullable is not', () => {
    const base = manifest(model('User', 'users', [col('A', { nullable: true }), col('B')]));
    expect(modelChanges(base, manifest(model('User', 'users', [col('A'), col('B', { nullable: true })])))).to.deep.equal([
      { section: 'models', kind: 'changed', id: 'default:users', breaking: true, detail: 'column A is now NOT NULL; column B is now nullable' },
    ]);
    expect(modelChanges(base, manifest(model('User', 'users', [col('A', { nullable: true }), col('B', { nullable: true })])))[0]).to.include({ breaking: false, detail: 'column B is now nullable' });
  });

  it('an explicit family change is breaking; a change from an inferred spec is not', () => {
    const explicit = (family: 'integer' | 'text' | 'uuid'): ModelColumn => col('Id', { sql: { family } });
    expect(modelChanges(manifest(model('U', 'u', [explicit('integer')])), manifest(model('U', 'u', [explicit('text')])))[0]).to.include({ breaking: true, detail: 'column Id changed from integer to text' });
    expect(modelChanges(manifest(model('U', 'u', [col('Id')])), manifest(model('U', 'u', [explicit('uuid')])))[0]).to.include({ breaking: false, detail: 'column Id SQL spec changed' });
  });

  it('narrowing is breaking, widening is not', () => {
    const email = (length: number): ModelColumn => col('Email', { sql: { family: 'text', length } });
    expect(modelChanges(manifest(model('U', 'u', [email(320)])), manifest(model('U', 'u', [email(100)])))[0]).to.include({ breaking: true, detail: 'column Email narrowed (length 320 -> 100)' });
    expect(modelChanges(manifest(model('U', 'u', [email(320)])), manifest(model('U', 'u', [email(500)])))[0]).to.include({ breaking: false, detail: 'column Email SQL spec changed' });
  });

  it('models on one table are one table (D19), and the connection is part of the id', () => {
    const base = manifest(model('User', 'users', [col('Id'), col('Email')]), model('UserAuth', 'users', [col('Id'), col('Password')]));
    expect(modelChanges(base, manifest(model('User', 'users', [col('Id'), col('Email'), col('Password')])))).to.deep.equal([]);
    expect(modelChanges(manifest(), manifest(model('Report', 'users', [col('Id')], { connection: 'reports' })))).to.deep.equal([{ section: 'models', kind: 'added', id: 'reports:users', breaking: false }]);
  });

  it('renders a models section', () => {
    expect(renderMarkdown(diffManifest(manifest(model('Log', 'logs', [col('Id')])), manifest()))).to.contain('### models');
  });
});
