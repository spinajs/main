import 'mocha';
import { expect } from 'chai';
import { publicContradictsGuard } from '../../src/doctor/rules/public-contradicts-guard.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('HTTP006 public-contradicts-guard', () => {
  it('warns when @Public sits next to @Access or @Policy on the same route or its class', () => {
    const m = fixture({
      controllers: [
        controller({
          className: 'Mixed',
          routes: [
            route({ handler: 'both', public: 'why', access: ['x:read'], source: src('src/mixed.ts', 7) }),
            route({ handler: 'withPolicy', public: 'why', policies: [[{ type: 'AuthPolicy' }]], source: src('src/mixed.ts', 12) }),
            route({ handler: 'fine', public: 'why' }),
            route({ handler: 'anonymousAccess', allowAnonymous: true, access: ['x:read'] }),
          ],
        }),
        controller({ className: 'GuardedClass', access: ['x:read'], routes: [route({ handler: 'open', public: 'why', source: src('src/g.ts', 3) })] }),
        controller({ className: 'PublicGuardedClass', public: 'why', policies: [[{ type: 'AuthPolicy' }]], routes: [route({ handler: 'x' })], source: src('src/p.ts', 1) }),
        controller({ className: 'PublicClassGuardedRoute', public: 'why', routes: [route({ handler: 'x', access: ['x:read'] })] }),
      ],
    });
    expect(publicContradictsGuard.run(m, ctx).map((d) => [d.code, d.severity, d.message, d.source?.line])).to.deep.equal([
      ['HTTP006', 'warning', 'Mixed.both is marked @Public but also has @Access or @Policy on it or on its class: the guard still runs.', 7],
      ['HTTP006', 'warning', 'Mixed.withPolicy is marked @Public but also has @Access or @Policy on it or on its class: the guard still runs.', 12],
      ['HTTP006', 'warning', 'GuardedClass.open is marked @Public but also has @Access or @Policy on it or on its class: the guard still runs.', 3],
      ['HTTP006', 'warning', 'PublicGuardedClass is marked @Public but also has @Access or @Policy on it or on its class: the guard still runs.', 1],
    ]);
  });
});
