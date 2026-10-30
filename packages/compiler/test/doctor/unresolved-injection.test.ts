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

  const inject = (token: string, extra: Record<string, unknown> = {}) => ({ property: token, token, optional: false, array: false, ...extra });

  it('treats container-provided tokens as resolvable but still reports an unregistered token beside them', () => {
    const m = fixture({
      services: [service({ className: 'C', propertyInjects: [inject('Container'), inject('Log'), inject('Configuration'), inject('Unregistered')] })],
    });
    expect(unresolvedInjection.run(m, ctx).map((d) => d.message)).to.deep.equal(["C injects 'Unregistered' (property Unregistered) but nothing registers it"]);
  });

  it('no longer exempts AsyncLocalStorage by name', () => {
    const m = fixture({ services: [service({ className: 'C', propertyInjects: [inject('AsyncLocalStorage')] })] });
    expect(unresolvedInjection.run(m, ctx)).to.have.length(1);
  });

  it('skips array injections (they resolve to an empty list)', () => {
    const m = fixture({ services: [service({ className: 'C', propertyInjects: [inject('BotVerifier', { array: true })] })] });
    expect(unresolvedInjection.run(m, ctx)).to.deep.equal([]);
  });

  it('resolves concrete classes by construction, flags abstract, interface and string tokens, and honours check', () => {
    const m = fixture({
      services: [
        service({
          className: 'C',
          ctorInjects: ['PlainCtor', 'AbstractCtor'],
          ctorConcrete: [true, false],
          propertyInjects: [
            inject('Plain', { concrete: true }),
            inject('Abstract'),
            inject('Iface'),
            inject('str.token'),
            inject('Checked', { concrete: true, check: true }),
          ],
        }),
      ],
    });
    expect(unresolvedInjection.run(m, ctx).map((d) => d.message)).to.deep.equal([
      "C injects 'AbstractCtor' (constructor argument 1) but nothing registers it",
      "C injects 'Abstract' (property Abstract) but nothing registers it",
      "C injects 'Iface' (property Iface) but nothing registers it",
      "C injects 'str.token' (property str.token) but nothing registers it",
      "C injects 'Checked' (property Checked) but nothing registers it",
    ]);
  });
});
