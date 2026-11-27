import 'mocha';
import { expect } from 'chai';
import { inheritSocketHandlers, type SocketCommandEntry, type SocketControllerEntry } from '../src/index.js';

const source = { file: 'src/s.ts', line: 1, col: 1, package: 'app' };
const entry = (partial: Partial<SocketControllerEntry>): SocketControllerEntry => ({ id: 'app:S', className: 'S', prefix: '', commands: [], events: [], source, ...partial });
const admin = [{ type: 'AdminPolicy', options: [] }];
const own = { type: 'SocketAccessPolicy', options: ['class'] };

describe('inheritSocketHandlers: the class access group', () => {
  it("replaces the base's SocketAccessPolicy group with the subclass's own", () => {
    const base = entry({ id: 'app:Base', className: 'Base', access: ['doc:read'], policies: [admin, [own]] });
    const sub = entry({ access: ['doc:update'], policies: [[own, { type: 'OwnerPolicy', options: [] }]] });
    expect(inheritSocketHandlers(sub, [base]).policies).to.deep.equal([admin, [own, { type: 'OwnerPolicy', options: [] }]]);
  });

  it('keeps a base group whose first member is not SocketAccessPolicy, as http-socket does', () => {
    const custom = [{ type: 'CustomPolicy', options: [] }, own];
    const base = entry({ id: 'app:Base', className: 'Base', access: ['doc:read'], policies: [custom] });
    const sub = entry({ access: ['doc:update'], policies: [[own]] });
    expect(inheritSocketHandlers(sub, [base]).policies).to.deep.equal([custom, [own]]);
  });

  it('still reads the AccessPolicy name a fragment of an older compiler carries', () => {
    const base = entry({ id: 'dep:Base', className: 'Base', access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['class'] }]] });
    const sub = entry({ access: ['doc:update'], policies: [[own]] });
    expect(inheritSocketHandlers(sub, [base]).policies).to.deep.equal([[own]]);
  });
});

describe('inheritSocketHandlers: the class fields', () => {
  const base = entry({ id: 'app:Base', className: 'Base', access: ['doc:read'], fields: 'filter', policies: [[own]] });

  it("gives a subclass without its own class access the base's fields, through every level", () => {
    const mid = entry({ id: 'app:Mid', className: 'Mid' });
    expect(inheritSocketHandlers(entry({}), [base]).fields).to.equal('filter');
    expect(inheritSocketHandlers(entry({}), [mid, base]).fields).to.equal('filter');
  });

  it('drops them under a class access of its own without fields, and keeps its own', () => {
    expect(inheritSocketHandlers(entry({ access: ['doc:update'] }), [base])).to.not.have.property('fields');
    expect(inheritSocketHandlers(entry({ access: ['doc:update'], fields: 'filter-rows' }), [base]).fields).to.equal('filter-rows');
  });

  it('records none when the base comes from a fragment older than the field', () => {
    const older = entry({ id: 'dep:Base', className: 'Base', access: ['doc:read'], policies: [[own]] });
    expect(inheritSocketHandlers(entry({}), [older])).to.deep.include({ access: ['doc:read'] }).and.not.have.property('fields');
  });
});

describe('inheritSocketHandlers: a redeclared command keeps the base handler guards, as http-socket copies its descriptor', () => {
  const cmd = (partial: Partial<SocketCommandEntry>): SocketCommandEntry => ({ name: 'p', handler: 'p', payload: { text: 'void' }, result: { text: 'Doc' }, options: {}, policies: [], source, ...partial });
  const handlerGroup = [{ type: 'SocketAccessPolicy', options: ['handler'] }];
  const base = entry({ id: 'app:Base', className: 'Base', access: ['doc:read'], fields: 'filter', policies: [[own]], commands: [cmd({ access: ['doc:update'], policies: [handlerGroup] }), cmd({ name: 'g', handler: 'g', access: ['doc:update'], fields: 'filter-rows', policies: [handlerGroup] })] });
  const guards = (s: SocketControllerEntry) => s.commands.map((c) => [c.handler, c.access, c.fields, c.policies]);

  it('keeps the access, fields and handler group of the base command under a bare @Command()', () => {
    expect(guards(inheritSocketHandlers(entry({ commands: [cmd({}), cmd({ name: 'g', handler: 'g' })] }), [base]))).to.deep.equal([
      ['p', ['doc:update'], undefined, [handlerGroup]],
      ['g', ['doc:update'], 'filter-rows', [handlerGroup]],
    ]);
  });

  it('replaces the base handler group with its own @SocketAccess, and keeps its own fields', () => {
    expect(guards(inheritSocketHandlers(entry({ commands: [cmd({ access: ['doc:own'], policies: [handlerGroup] })] }), [base]))).to.deep.equal([
      ['p', ['doc:own'], undefined, [handlerGroup]],
      ['g', ['doc:update'], 'filter-rows', [handlerGroup]],
    ]);
  });

  it('changes nothing when merged twice', () => {
    const once = inheritSocketHandlers(entry({ commands: [cmd({})] }), [base]);
    expect(inheritSocketHandlers(once, [base])).to.deep.equal(once);
  });
});
