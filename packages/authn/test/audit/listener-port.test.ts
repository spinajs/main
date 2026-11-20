import assert from 'node:assert/strict';
import 'mocha';

import { AuthnAudit, AuthnEventListener, AuthnEventSink } from '../../src/index.js';
import type { AuthnEvent } from '../../src/index.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const AT = new Date('2026-11-16T10:00:00Z');
const login = (): AuthnEvent => ({ type: 'login', at: AT, outcome: 'success', identity: { type: 'user', id: 'u-1' } });

class Listening extends AuthnEventListener {
  readonly seen: AuthnEvent[] = [];
  readonly calls: string[] = [];

  async on(e: AuthnEvent): Promise<void> {
    this.seen.push(e);
  }

  ready(): void {
    this.calls.push('ready');
  }

  async flush(): Promise<void> {
    this.calls.push('flush');
  }
}

class LegacySink extends AuthnEventSink {
  readonly seen: AuthnEvent[] = [];

  async publish(e: AuthnEvent): Promise<void> {
    this.seen.push(e);
  }
}

class NotReady extends AuthnEventListener {
  async on(): Promise<void> {}

  ready(): void {
    throw new Error('the trail is not configured');
  }
}

class FailingFlush extends AuthnEventListener {
  async on(): Promise<void> {}

  async flush(): Promise<void> {
    throw new TypeError('store down');
  }
}

describe('AuthnEventListener', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  async function auditWith(...listeners: [string, AuthnEventListener][]): Promise<AuthnAudit> {
    parts = await buildCore({}, { register: (c) => listeners.forEach(([name, listener]) => bind(c, AuthnEventListener, name, listener)) });
    return parts.child.resolve(AuthnAudit);
  }

  it('hands every published event, frozen, to a registered listener', async () => {
    const listener = new Listening();
    const audit = await auditWith(['Listening', listener]);

    await audit.publish(login());

    assert.deepStrictEqual(listener.seen.map((e) => e.type), ['login']);
    assert.ok(Object.isFrozen(listener.seen[0]));
    assert.ok(audit.listeners().includes(listener));
  });

  it('asks a listener whether it is ready when it resolves, and a refusal fails the boot', async () => {
    const listener = new Listening();
    await auditWith(['Listening', listener]);
    assert.deepStrictEqual(listener.calls, ['ready']);
    await parts?.dispose();
    parts = undefined;

    await assert.rejects(auditWith(['NotReady', new NotReady()]), /the trail is not configured/);
  });

  it('settled() flushes the listeners that buffer, and a failing flush is logged, not thrown', async () => {
    const listener = new Listening();
    const audit = await auditWith(['Listening', listener], ['FailingFlush', new FailingFlush()]);

    await audit.settled();

    assert.deepStrictEqual(listener.calls, ['ready', 'flush']);
  });

  it('over() delivers to the listeners it is given, bounded by listenerTimeoutMs', async () => {
    const listener = new Listening();
    const never: AuthnEventListener = new (class extends AuthnEventListener {
      on(): Promise<void> {
        return new Promise(() => undefined);
      }
    })();
    const warnings: unknown[] = [];

    await AuthnAudit.over([never, listener], { listenerTimeoutMs: 20, log: { warn: (...args: unknown[]) => void warnings.push(args) } }).publish(login());

    assert.strictEqual(listener.seen.length, 1);
    assert.strictEqual(warnings.length, 1);
  });

  // Removed with AuthnEventSink (the last branch of the authn stack).
  it('still delivers to a class registered under the deprecated AuthnEventSink name', async () => {
    const legacy = new LegacySink();
    parts = await buildCore({}, { register: (c) => bind(c, AuthnEventSink, 'LegacySink', legacy) });
    const audit = await parts.child.resolve(AuthnAudit);

    await audit.publish(login());

    assert.strictEqual(legacy.seen.length, 1);
    assert.ok(audit.listeners().includes(legacy));
  });
});
