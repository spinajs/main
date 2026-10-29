import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractModels } from '../../src/index.js';

describe('extractModels', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('model.ts'))!;
  const models = extractModels(ctx, file);
  const post = models.find((m) => m.className === 'Post')!;

  it('finds every @Model', () => {
    expect(models.map((m) => [m.className, m.tableName, m.accessResource])).to.deep.equal([
      ['Tag', 'tags', false],
      ['PostTag', 'post_tags', false],
      ['Post', 'posts', true],
    ]);
  });

  it('Post columns, relations, connection', () => {
    expect(post).to.deep.include({ id: 'pkg-basic:Post', connection: 'default', accessResource: true });
    expect(post.columns).to.deep.equal([
      { name: 'Id', type: { text: 'number' }, primary: true, nullable: false },
      { name: 'Title', type: { text: 'string' }, primary: false, nullable: false },
      { name: 'Body', type: { text: 'string' }, primary: false, nullable: true },
      { name: 'PublishedAt', type: { text: 'Date' }, primary: false, nullable: true },
    ]);
    expect(post.relations).to.deep.equal([
      { name: 'Owner', kind: 'belongsTo', target: 'User' },
      { name: 'MainTag', kind: 'forwardBelongsTo', target: 'Tag' },
      { name: 'Tags', kind: 'hasMany', target: 'Tag' },
      { name: 'AllTags', kind: 'hasManyToMany', target: 'Tag' },
    ]);
  });
});
