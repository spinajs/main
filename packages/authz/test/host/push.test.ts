import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_CHANGED_EVENT, AccessChangeRouter, AccessPushTransport, ChangeAudience, ChangeBus } from '@spinajs/authz';
import type { AccessChangedEvent, AuthzChange, HostLog } from '@spinajs/authz';
import { domains, installHost, instance, registerInRoot, resetHost, resetRoot, rootService, uninstallHost } from './support.js';

const expect = chai.expect;

class RecordingTransport extends AccessPushTransport {
  readonly pushes: { principals: readonly string[] | '*'; event: AccessChangedEvent }[] = [];

  constructor(readonly name: string, private readonly fail = false) {
    super();
  }

  async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    this.pushes.push({ principals, event });
    if (this.fail) throw new Error(`${this.name} down`);
  }
}

class FixedAudience extends ChangeAudience {
  readonly asked: AuthzChange[] = [];

  constructor(private readonly answer: unknown) {
    super();
  }

  async audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly { type: string; id?: string }[] }> {
    this.asked.push(change);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer as { principals: readonly string[] | '*' };
  }
}

class QuietRouter extends AccessChangeRouter {
  readonly errors: string[] = [];
  protected log: HostLog = { error: (m: string) => void this.errors.push(m), warn: () => {}, info: () => {}, debug: () => {} };
}

const change = (tags: string[]): AuthzChange => ({ domain: 'root', tags, at: new Date(0) });
const task7 = { type: 'task', id: '7' };
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('AccessChangeRouter', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  describe('route', () => {
    let c: IContainer;

    beforeEach(() => {
      c = DI.RootContainer.child();
    });

    afterEach(async () => {
      await c.dispose();
    });

    it('asks no audience while no transport is registered', async () => {
      const audience = new FixedAudience({ principals: ['user:1'] });
      c.register(instance(audience)).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(audience.asked).to.deep.equal([]);
    });

    it("pushes tags ['*'] to every session without asking the audiences", async () => {
      const t = new RecordingTransport('sse');
      const audience = new FixedAudience({ principals: ['user:1'] });
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(audience)).as(ChangeAudience);
      await new QuietRouter().route(change(['*']), c);
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
      expect(audience.asked).to.deep.equal([]);
    });

    it('pushes to every session when no audience is registered', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
    });

    it('pushes the sorted union of the audiences, with objects when every audience is exact', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: ['user:2', 'user:1'], objects: [task7] }))).as(ChangeAudience);
      c.register(instance(new FixedAudience({ principals: ['user:1', 'user:3'], objects: [] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: ['user:1', 'user:2', 'user:3'], event: { objects: [task7] } }]);
    });

    it('drops objects when one audience is not exact', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: ['user:1'], objects: [task7] }))).as(ChangeAudience);
      c.register(instance(new FixedAudience({ principals: ['user:2'] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: ['user:1', 'user:2'], event: {} }]);
    });

    it('widens the push to every session when an audience throws or answers malformed, and logs it', async () => {
      for (const answer of [new Error('membership store down'), { principals: 'everyone' }]) {
        const child = DI.RootContainer.child();
        const t = new RecordingTransport('sse');
        child.register(instance(t)).as(AccessPushTransport);
        child.register(instance(new FixedAudience(answer))).as(ChangeAudience);
        const router = new QuietRouter();
        await router.route(change(['subject:user:1']), child);
        expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
        expect(router.errors).to.have.length(1);
        await child.dispose();
      }
    });

    it('logs a failing transport and still pushes to the others', async () => {
      const bad = new RecordingTransport('socket', true);
      const good = new RecordingTransport('sse');
      c.register(instance(bad)).as(AccessPushTransport);
      c.register(instance(good)).as(AccessPushTransport);
      const router = new QuietRouter();
      await router.route(change(['*']), c);
      expect(good.pushes).to.have.length(1);
      expect(router.errors.join('\n')).to.contain('socket');
    });

    it('pushes nothing for an empty audience', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: [], objects: [] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['role:editor']), c);
      expect(t.pushes).to.deep.equal([]);
    });
  });

  describe('wiring', () => {
    it('the root domain routes the changes of its ChangeBus', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
      expect(AUTHZ_CHANGED_EVENT).to.equal('authz.changed');
    });

    it('a child domain does not route the same change again', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      const d = await domains();
      d.create('fs');
      await d.service('fs');
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.have.length(1);
    });

    it('disposing the root service stops the routing', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      await resetRoot();
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.deep.equal([]);
    });
  });
});
