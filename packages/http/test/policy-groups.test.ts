import 'mocha';
import { expect } from 'chai';
import { createPolicyGate } from '../src/route-builder.js';
import { BaseController, Get, Ok, Policy, CONTROLLED_DESCRIPTOR_SYMBOL } from '../src/index.js';
import { BasePolicy } from '../src/interfaces.js';
import type { IController, IControllerDescriptor, IRoute } from '../src/interfaces.js';

/**
 * Policy stub with a fixed verdict. `Name` is what the assertions read back off
 * a forwarded rejection, so each stub must be distinguishable.
 */
class StubPolicy extends BasePolicy {
  constructor(public Name: string, private readonly _passes: boolean, private readonly _enabled = true) {
    super();
  }

  public isEnabled(): boolean {
    return this._enabled;
  }

  public async execute(): Promise<void> {
    if (!this._passes) {
      throw new Error(`${this.Name} rejected`);
    }
  }
}

const pass = (name: string) => new StubPolicy(name, true);
const fail = (name: string) => new StubPolicy(name, false);
const disabled = (name: string) => new StubPolicy(name, false, false);

const ROUTE = { Method: 'test', Path: 'test' } as unknown as IRoute;
const CONTROLLER = { constructor: { name: 'TestController' }, BasePath: 'test' } as unknown as IController;
const LOG = { trace: () => {}, warn: () => {} } as any;

/**
 * Runs the gate and reports how it dispatched: `next()` with no argument means
 * the route may run, `next(err)` means it was blocked with that error.
 *
 * Groups default to the route scope, which is where a single `@Policy()` on an
 * action lands; the controller scope is passed explicitly where it matters.
 */
function runGate(route: BasePolicy[][], controllerScope: BasePolicy[][] = []): Promise<{ allowed: boolean; error?: Error }> {
  return new Promise((resolve) => {
    const gate = createPolicyGate({ Controller: controllerScope, Route: route }, ROUTE, CONTROLLER, LOG);
    gate({} as any, {} as any, ((err?: any) => resolve({ allowed: !err, error: err })) as any);
  });
}

// Own metadata only - a class's own descriptor is what its decorators wrote.
const descriptorOf = (c: object) => Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, c) as IControllerDescriptor;

describe('policy groups', () => {
  describe('createPolicyGate', () => {
    it('runs the route when every member of an AND group resolves', async () => {
      const result = await runGate([[pass('A'), pass('B')]]);
      expect(result.allowed).to.eq(true);
    });

    it('blocks the route when one member of an AND group rejects', async () => {
      const result = await runGate([[pass('A'), fail('B')]]);
      expect(result.allowed).to.eq(false);
      expect(result.error?.message).to.eq('B rejected');
    });

    it('forwards the first rejection in declaration order', async () => {
      const result = await runGate([[fail('A'), fail('B')]]);
      expect(result.error?.message).to.eq('A rejected');
    });

    it('runs the route when a later group passes and an earlier one fails', async () => {
      const result = await runGate([[fail('A')], [pass('B')]]);
      expect(result.allowed).to.eq(true);
    });

    it('runs the route when a single-policy group passes next to a failing AND group', async () => {
      const result = await runGate([[pass('A'), fail('B')], [pass('C')]]);
      expect(result.allowed).to.eq(true);
    });

    it('blocks the route when no group holds', async () => {
      const result = await runGate([[pass('A'), fail('B')], [fail('C')]]);
      expect(result.allowed).to.eq(false);
      expect(result.error?.message).to.eq('B rejected');
    });

    it('lets the remaining member decide when a group member is disabled', async () => {
      expect((await runGate([[disabled('A'), fail('B')]])).allowed, 'disabled member must not mask a rejecting sibling').to.eq(false);
      expect((await runGate([[disabled('A'), pass('B')]])).allowed).to.eq(true);
    });

    it('drops a fully disabled group instead of treating it as passing', async () => {
      // The empty AND is vacuously true. Treating it that way would open the
      // route for everyone even though its other group is a live check.
      const result = await runGate([[disabled('A')], [fail('B')]]);
      expect(result.allowed).to.eq(false);
      expect(result.error?.message).to.eq('B rejected');
    });

    it('allows the route when every group is disabled', async () => {
      // No active authorization check left - same meaning as no policies at all.
      const result = await runGate([[disabled('A')], [disabled('B')]]);
      expect(result.allowed).to.eq(true);
    });

    it('allows the route when it has no policies', async () => {
      expect((await runGate([])).allowed).to.eq(true);
    });
  });

  describe('createPolicyGate scopes', () => {
    it('requires both scopes to hold', async () => {
      expect((await runGate([[pass('route')]], [[pass('controller')]])).allowed).to.eq(true);
      expect((await runGate([[fail('route')]], [[pass('controller')]])).allowed).to.eq(false);
      expect((await runGate([[pass('route')]], [[fail('controller')]])).allowed).to.eq(false);
    });

    it('does not let a controller policy stand in for the route own policies', async () => {
      // The bug this scope split exists for: a permissive controller-wide
      // policy must never be an alternative to the route's own check.
      const result = await runGate([[fail('route')]], [[pass('controller')]]);
      expect(result.allowed).to.eq(false);
      expect(result.error?.message).to.eq('route rejected');
    });

    it('still combines the groups of one scope with OR', async () => {
      expect((await runGate([[fail('a')], [pass('b')]], [[pass('controller')]])).allowed).to.eq(true);
    });

    it('reports the failure of the first scope that did not hold', async () => {
      const result = await runGate([[fail('route')]], [[fail('controller')]]);
      expect(result.error?.message).to.eq('controller rejected');
    });

    it('passes a scope that declares nothing', async () => {
      expect((await runGate([[pass('route')]], [])).allowed).to.eq(true);
      expect((await runGate([], [[pass('controller')]])).allowed).to.eq(true);
      expect((await runGate([[fail('route')]], [])).allowed).to.eq(false);
    });

    it('passes a scope whose every group is disabled', async () => {
      expect((await runGate([[pass('route')]], [[disabled('controller')]])).allowed).to.eq(true);
    });
  });

  describe('@Policy', () => {
    class P1 extends StubPolicy {
      constructor() {
        super('P1', true);
      }
    }
    class P2 extends StubPolicy {
      constructor() {
        super('P2', true);
      }
    }
    class P3 extends StubPolicy {
      constructor() {
        super('P3', true);
      }
    }

    @Policy([P1, P2])
    @Policy(P3)
    class GroupedController extends BaseController {
      @Get()
      @Policy([P1, 'http.some.policy.key'])
      public async withArray() {
        return new Ok();
      }

      @Get()
      @Policy(P1)
      @Policy(P2)
      public async stacked() {
        return new Ok();
      }

      public async resolve() {
        /* skip BaseController wiring - the descriptor is all this asserts on */
      }
    }

    const descriptor = () => descriptorOf(GroupedController.prototype);

    it('collects an array into one group and a single policy into its own', () => {
      const groups = descriptor().Policies.map((g) => g.map((p) => p.Type));
      expect(groups).to.have.deep.members([[P1, P2], [P3]]);
    });

    it('keeps stacked decorators as separate groups', () => {
      const groups = descriptor().Routes.get('stacked')!.Policies.map((g) => g.map((p) => p.Type));
      expect(groups).to.have.deep.members([[P1], [P2]]);
    });

    it('keeps a configuration key inside an array as one policy', () => {
      const groups = descriptor().Routes.get('withArray')!.Policies;
      expect(groups).to.have.lengthOf(1);
      expect(groups[0].map((p) => p.Type)).to.deep.eq([P1, 'http.some.policy.key']);
    });

    it('passes the same options to every policy in a group', () => {
      @Policy([P1, P2], { scope: 'admin' })
      class WithOptions extends BaseController {
        public async resolve() {
          /* see above */
        }
      }

      const group = descriptorOf(WithOptions.prototype).Policies[0];
      expect(group.map((p) => p.Options)).to.deep.eq([[{ scope: 'admin' }], [{ scope: 'admin' }]]);
    });
  });
});
