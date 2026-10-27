import 'mocha';
import { expect } from 'chai';
import { diCycle, tarjan } from '../../src/doctor/rules/di-cycle.js';
import { fixture, service, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('tarjan', () => {
  it('finds strongly connected components of size > 1 and self loops', () => {
    const edges = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['d']], ['e', ['a']]]);
    expect(tarjan(['a', 'b', 'c', 'd', 'e'], edges).map((c) => [...c].sort())).to.deep.equal([['a', 'b', 'c'], ['d']]);
  });
});

describe('DI002 di-cycle', () => {
  it('reports a hard cycle as an error, rotated to the smallest name', () => {
    const m = fixture({
      services: [
        service({ className: 'Orm', ctorInjects: ['Migrator'], source: src('src/orm.ts', 10) }),
        service({ className: 'Migrator', propertyInjects: [{ property: 'orm', token: 'Orm', optional: false, array: false }] }),
      ],
    });
    expect(diCycle.run(m, ctx)).to.deep.equal([
      { code: 'DI002', severity: 'error', message: 'Dependency cycle: Migrator -> Orm -> Migrator', source: src('src/Migrator.ts') },
    ]);
  });

  it('reports a cycle broken by an optional or lazy injection as a warning', () => {
    const m = fixture({
      services: [
        service({ className: 'A', ctorInjects: ['B'] }),
        service({ className: 'B', propertyInjects: [{ property: 'a', token: 'A', optional: false, array: false, lazy: true }] }),
      ],
    });
    expect(diCycle.run(m, ctx).map((d) => d.severity)).to.deep.equal(['warning']);
  });

  it('ignores tokens served by values and acyclic graphs', () => {
    const m = fixture({
      services: [service({ className: 'A', ctorInjects: ['__configuration__', 'B'] }), service({ className: 'B' })],
      values: [{ token: '__configuration__', kind: 'value', source: src('src/c.ts') }],
    });
    expect(diCycle.run(m, ctx)).to.deep.equal([]);
  });
});
