import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractModels } from '../../src/index.js';
import { accessResources } from '../../src/extractors/access-resources.js';

const UNREAD = ['typeColumn'];

describe('relation columns of an access resource', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('access-relation-columns.ts'))!;
  const { resources } = accessResources(ctx, [file], extractModels(ctx, file));
  const relationsOf = (type: string) => resources.find((r) => r.type === type)?.relations;

  it('records the type column of an owner and a relation, and a nullable parent, written as the build can read them', () => {
    expect(relationsOf('ticket')).to.have.deep.members([
      { name: 'parent', kind: 'parent', column: 'QueueId', target: 'queue', nullable: true },
      { name: 'parent', kind: 'parent', column: 'ProjectId', target: 'project' },
      { name: 'parent', kind: 'parent', column: 'BoardId', target: 'board' },
      { name: 'parent', kind: 'parent', column: 'LaneId', target: 'lane', unread: ['nullable'] },
      { name: 'owner', kind: 'owner', column: 'OwnerId', typeColumn: 'OwnerType' },
      { name: 'watcher', kind: 'relation', column: 'WatcherId', typeColumn: 'WatcherType' },
      { name: 'reviewer', kind: 'relation', column: 'ReviewerId' },
      { name: 'constant', kind: 'relation', column: 'ConstantId', typeColumn: 'ConstType' },
      { name: 'imported', kind: 'relation', column: 'ImportedId', typeColumn: 'SharedType' },
      { name: 'asConst', kind: 'relation', column: 'AsConstId', typeColumn: 'AsConstType' },
      { name: 'satisfied', kind: 'relation', column: 'SatisfiedId', typeColumn: 'SatisfiedType' },
      { name: 'shorthand', kind: 'relation', column: 'ShorthandId', typeColumn: 'ShortType' },
      { name: 'spread', kind: 'relation', column: 'SpreadId', typeColumn: 'ConstType' },
      { name: 'computed', kind: 'relation', column: 'ComputedId', typeColumn: 'ComputedType' },
      { name: 'overridden', kind: 'relation', column: 'OverriddenId', typeColumn: 'LastWins' },
      { name: 'called', kind: 'relation', column: 'CalledId', unread: UNREAD },
      { name: 'reassigned', kind: 'relation', column: 'ReassignedId', unread: UNREAD },
      { name: 'importedLet', kind: 'relation', column: 'ImportedLetId', unread: UNREAD },
      { name: 'unreadSpread', kind: 'relation', column: 'UnreadSpreadId', unread: UNREAD },
      { name: 'unreadKey', kind: 'relation', column: 'UnreadKeyId', unread: UNREAD },
      { name: 'classRef', kind: 'relation', column: 'ClassRefId', unread: UNREAD },
    ]);
    expect(relationsOf('subTicket')).to.have.deep.members(relationsOf('ticket')!);
  });

  it('records the type columns of registration options read in full, and leaves them unread otherwise', () => {
    expect(relationsOf('registered')).to.have.deep.members([
      { name: 'parent', kind: 'parent', column: 'FolderId', target: 'folder' },
      { name: 'owner', kind: 'owner', column: 'OwnerId', typeColumn: 'OwnerType' },
      { name: 'editor', kind: 'relation', column: 'EditorId', typeColumn: 'EditorType' },
      { name: 'viewer', kind: 'relation', column: 'ViewerId' },
    ]);
    expect(relationsOf('partly')).to.have.deep.members([
      { name: 'owner', kind: 'owner', column: 'OwnerId', unread: UNREAD },
      { name: 'editor', kind: 'relation', column: 'EditorId', unread: UNREAD },
    ]);
    expect(relationsOf('lately')).to.deep.equal([{ name: 'owner', kind: 'owner', column: 'OwnerId', unread: UNREAD }]);
  });

  it('notes each option it leaves unread once, at the options', () => {
    const notes = ctx.diagnostics.filter((d) => d.code === 'CMP001' && d.message.includes('recorded as unread'));
    expect(notes.map((d) => [d.severity, d.source?.line])).to.deep.equal([
      ['info', 26],
      ['info', 38],
      ['info', 39],
      ['info', 40],
      ['info', 41],
      ['info', 42],
      ['info', 44],
      ['info', 67],
      ['info', 68],
    ]);
  });
});
