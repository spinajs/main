import 'mocha';
import { expect } from 'chai';
import { conditionUnmet } from '../../src/doctor/rules/condition-unmet.js';
import { fixture, service, controller, src } from './fixture.js';

describe('CFG003 condition-unmet', () => {
  const base = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
  const later = { code: 'CFG003', severity: 'warning', message: 'Later registers conditionally (registered in bootstrap()); the manifest cannot tell whether it loads', source: src('src/later.ts', 8) };
  const m = fixture({
    services: [
      service({ className: 'OidcProvider', condition: { kind: 'config', path: 'authn.oidc.enabled' }, source: src('src/oidc.ts', 2) }),
      service({ className: 'SqsTransport', condition: { kind: 'config', path: 'queue.default', expected: 'sqs' } }),
      service({ className: 'Later', condition: { kind: 'dynamic', reason: 'registered in bootstrap()' }, source: src('src/later.ts', 8) }),
    ],
    values: [{ token: '__x__', kind: 'value', source: src('src/x.ts'), condition: { kind: 'config', path: 'x.on' } }],
    controllers: [controller({ className: 'AdminController', condition: { kind: 'config', path: 'admin.enabled' } })],
  });

  it('without config: only dynamic conditions are reported', () => {
    expect(conditionUnmet.run(m, base)).to.deep.equal([later]);
  });

  it('with config: unmet config conditions are listed as info', () => {
    const ctx = { ...base, config: { authn: { oidc: { enabled: false } }, queue: { default: 'amqp' }, x: { on: true }, admin: { enabled: true } } };
    expect(conditionUnmet.run(m, ctx)).to.deep.equal([
      { code: 'CFG003', severity: 'info', message: "OidcProvider will not register: config 'authn.oidc.enabled' is falsy", source: src('src/oidc.ts', 2) },
      { code: 'CFG003', severity: 'info', message: 'SqsTransport will not register: config \'queue.default\' is not "sqs"', source: src('src/SqsTransport.ts') },
      later,
    ]);
  });
});
