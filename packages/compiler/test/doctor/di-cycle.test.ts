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

  it('keeps a hard cycle an error when the component also has soft edges', () => {
    const soft = { optional: true, array: false };
    const m = fixture({
      services: [
        service({ className: 'A', ctorInjects: ['B'] }),
        service({ className: 'B', ctorInjects: ['A'], propertyInjects: [{ property: 'c', token: 'C', ...soft }] }),
        service({ className: 'C', propertyInjects: [{ property: 'b', token: 'B', ...soft }] }),
      ],
    });
    const out = diCycle.run(m, ctx);
    expect(out.map((d) => [d.severity, d.message])).to.deep.equal([['error', 'Dependency cycle: A -> B -> A']]);
  });

  it('prints a real edge path through a component with a chord', () => {
    const m = fixture({
      services: [
        service({ className: 'A', ctorInjects: ['B', 'C'] }),
        service({ className: 'B', ctorInjects: ['C'] }),
        service({ className: 'C', ctorInjects: ['A'] }),
      ],
    });
    expect(diCycle.run(m, ctx).map((d) => d.message)).to.deep.equal(['Dependency cycle: A -> C -> A']);
  });

  it('reports disjoint components separately and self loops', () => {
    const m = fixture({
      services: [
        service({ className: 'A', ctorInjects: ['B'] }),
        service({ className: 'B', ctorInjects: ['A'] }),
        service({ className: 'X', ctorInjects: ['Y'] }),
        service({ className: 'Y', ctorInjects: ['X'] }),
        service({ className: 'Self', ctorInjects: ['Self'] }),
      ],
    });
    expect(diCycle.run(m, ctx).map((d) => d.message).sort()).to.deep.equal([
      'Dependency cycle: A -> B -> A',
      'Dependency cycle: Self -> Self',
      'Dependency cycle: X -> Y -> X',
    ]);
  });

  it('reports only the component that is hard, not the smallest id of the whole SCC', () => {
    const m = fixture({
      services: [
        service({ className: 'A', ctorInjects: ['B'] }),
        service({ className: 'B', ctorInjects: ['C'], propertyInjects: [{ property: 'a', token: 'A', optional: true, array: false }] }),
        service({ className: 'C', ctorInjects: ['B'] }),
      ],
    });
    expect(diCycle.run(m, ctx).map((d) => [d.severity, d.message])).to.deep.equal([['error', 'Dependency cycle: B -> C -> B']]);
  });
});
