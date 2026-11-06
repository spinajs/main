import { expect } from 'chai';
import ts from 'typescript';
import { createContext, createProgramFromTsconfig, extractModels } from '../../src/index.js';

describe('extractModels v2: SQL specs, relation keys, indexes', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-models-v2/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-models-v2', 'test/fixtures/pkg-models-v2');
  const models = loaded.sourceFiles.flatMap((f) => extractModels(ctx, f));
  const byName = (name: string) => models.find((m) => m.className === name)!;
  const sqlOf = (name: string) => Object.fromEntries(byName(name).columns.map((c) => [c.name, c.sql]));

  it('the fixture type-checks under typescript 5.9 (orm built with @Column and @Index)', () => {
    const errors = ts.getPreEmitDiagnostics(loaded.program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).to.deep.equal([]);
  });

  it('gives every column a family: a stated family is explicit, the rest are inferred (D8, Q15)', () => {
    expect(sqlOf('Author')).to.deep.equal({
      Id: { family: 'integer', autoIncrement: true, inferred: true },
      Email: { family: 'text', length: 320, unique: true },
      FirstName: { family: 'text', inferred: true },
      LastName: { family: 'text', inferred: true },
      Active: { family: 'boolean', inferred: true },
      Score: { family: 'bigint', inferred: true },
      Views: { family: 'bigint', inferred: true },
      BirthDate: { family: 'datetime', inferred: true },
      CreatedAt: { family: 'datetime', inferred: true },
      Settings: { family: 'json', inferred: true },
      Avatar: { family: 'binary', inferred: true },
      Kind: { family: 'text', inferred: true },
      Balance: { family: 'decimal', precision: 10, scale: 2, default: 0 },
      SeenAt: { family: 'datetime', default: { raw: 'CURRENT_TIMESTAMP' }, inferred: true },
      Version: { family: 'integer', version: true, inferred: true },
    });
    expect(sqlOf('Post')).to.deep.equal({ Id: { family: 'uuid', inferred: true } });
  });

  it('covers the remaining inference rules (A18): decorators over types, assigned keys, enum only when stated', () => {
    expect(sqlOf('Event')).to.deep.equal({
      Id: { family: 'bigint', autoIncrement: true, inferred: true },
      Seq: { family: 'integer', inferred: true },
      Count: { family: 'integer', inferred: true },
      At: { family: 'datetime', inferred: true },
      Blob: { family: 'binary', inferred: true },
      Payload: { family: 'json', inferred: true },
      Flag: { family: 'boolean', inferred: true },
      Stamp: { family: 'datetime', inferred: true },
      UpdatedAt: { family: 'datetime', inferred: true },
      DeletedAt: { family: 'datetime', inferred: true },
      ArchivedAt: { family: 'datetime', inferred: true },
      Code: { family: 'text', unique: true, inferred: true },
      Grade: { family: 'enum', enumValues: ['a', 'b'] },
    });
  });

  it('records @Index, @Version and the exhaustive option on the model', () => {
    expect(byName('Author')).to.deep.include({
      exhaustive: true,
      version: 'Version',
      indexes: [
        { name: 'authors_email_unique', columns: ['Email'], unique: true },
        { columns: ['LastName', 'FirstName'], unique: false },
      ],
    });
    expect(byName('Post')).to.not.have.any.keys('indexes', 'version', 'exhaustive');
  });

  it('records relation keys as the runtime defaults them', () => {
    expect(byName('Author').relations).to.deep.equal([{ name: 'Posts', kind: 'hasMany', target: 'Post', foreignKey: 'author_id' }]);
    expect(byName('Post').relations).to.deep.equal([
      { name: 'Author', kind: 'belongsTo', target: 'Author', foreignKey: 'author_id' },
      { name: 'Editor', kind: 'belongsTo', target: 'Author', foreignKey: 'editor', primaryKey: 'Id' },
      { name: 'Tags', kind: 'hasManyToMany', target: 'Tag', junction: { model: 'PostTag', sourceKey: 'post_id', targetKey: 'tag_ref' } },
    ]);
  });

  it('reads the decorator options without non-literal noise', () => {
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP001')).to.deep.equal([]);
  });
});
