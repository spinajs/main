import 'mocha';
import { expect } from 'chai';
import { unresolvedInjection } from '../../src/doctor/rules/unresolved-injection.js';
import { fixture, service, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('DI001 unresolved-injection', () => {
  it('reports constructor and property tokens nothing provides', () => {
    const m = fixture({
      services: [
        service({ className: 'Log', registeredAs: ['Log', '__log__'] }),
        service({ className: 'A', ctorInjects: ['Log', 'Missing'], propertyInjects: [{ property: 'cfg', token: '__configuration__', optional: false, array: false }, { property: 'opt', token: 'Nope', optional: true, array: false }], source: src('src/a.ts', 4) }),
      ],
      values: [{ token: '__configuration__', kind: 'value', source: src('src/cfg.ts') }],
    });
    expect(unresolvedInjection.run(m, ctx)).to.deep.equal([
      { code: 'DI001', severity: 'error', message: "A injects 'Missing' (constructor argument 1) but nothing registers it", source: src('src/a.ts', 4) },
    ]);
  });

  it('accepts a value map token and a class registered under its own name', () => {
    const m = fixture({
      services: [service({ className: 'B', ctorInjects: ['B'], propertyInjects: [{ property: 'errs', token: '__http_error_map__', optional: false, array: false }] })],
      values: [{ token: '__http_error_map__', kind: 'map', mapKey: 'NotFound', source: src('src/e.ts') }],
    });
    expect(unresolvedInjection.run(m, ctx)).to.deep.equal([]);
  });
});
