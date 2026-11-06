import { expect } from 'chai';
import 'mocha';
import { validateFragment } from '../src/index.js';
import type { ModelEntry } from '../src/index.js';
import { fragment, src } from './support.js';

const author: ModelEntry = {
  id: 'Author',
  className: 'Author',
  tableName: 'authors',
  columns: [
    { name: 'Id', type: { text: 'number' }, primary: true, nullable: false, sql: { family: 'integer', autoIncrement: true, inferred: true } },
    { name: 'Email', type: { text: 'string' }, primary: false, nullable: false, sql: { family: 'text', length: 320, unique: true } },
    { name: 'SeenAt', type: { text: 'Date' }, primary: false, nullable: true, sql: { family: 'datetime', default: { raw: 'CURRENT_TIMESTAMP' }, inferred: true } },
  ],
  relations: [
    { name: 'Posts', kind: 'hasMany', target: 'Post', foreignKey: 'author_id' },
    { name: 'Tags', kind: 'hasManyToMany', target: 'Tag', junction: { model: 'AuthorTag', sourceKey: 'author_id', targetKey: 'tag_id' } },
  ],
  indexes: [{ name: 'authors_email', columns: ['Email'], unique: true }],
  version: 'Version',
  exhaustive: true,
  accessResource: false,
  source: src('app'),
};

describe('model schema v2', () => {
  it('validates SQL specs, relation keys, indexes, version and exhaustive', () => {
    expect(validateFragment(fragment('app', { models: [author] }))).to.deep.equal([]);
  });

  it('rejects an unknown column family', () => {
    const bad = { ...author, columns: [{ ...author.columns[0], sql: { family: 'varchar' } }] };
    expect(validateFragment(fragment('app', { models: [bad as unknown as ModelEntry] }))).to.not.deep.equal([]);
  });

  it('still validates a model written before the v2 fields', () => {
    const { indexes: _i, version: _v, exhaustive: _e, ...rest } = author;
    const legacy: ModelEntry = { ...rest, columns: [{ name: 'Id', type: { text: 'number' }, primary: true, nullable: false }], relations: [{ name: 'Posts', kind: 'hasMany', target: 'Post' }] };
    expect(validateFragment(fragment('app', { models: [legacy] }))).to.deep.equal([]);
  });
});
