import 'mocha';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { AuthnService, MemoryAuthnThrottle } from '@spinajs/authn';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AuthnThrottle, IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import { FakeIdentityStore, RecordingPrincipalFactory } from '@spinajs/authn-testing';

import { AUTHN_SESSION_CONFIGURATION_SCHEMA, SessionProvider } from '../src/index.js';
import type { ISession } from '../src/index.js';

/** A store that is not process memory; its class carries no boot check, as DbSessionStore. */
class SharedTestStore extends SessionProvider {
  public async restore(): Promise<ISession | null> {
    return null;
  }

  public async save(): Promise<void> {}

  public async touch(): Promise<boolean> {
    return false;
  }

  public async delete(): Promise<boolean> {
    return false;
  }

  public async deleteBySubject(): Promise<number> {
    return 0;
  }

  public async listBySubject(): Promise<ISession[]> {
    return [];
  }

  public async truncate(): Promise<void> {}
}

const strong = (): string => randomBytes(32).toString('hex');

function configurationOf(values: Record<string, unknown>, env: string): Class<Configuration> {
  const json = JSON.stringify(values);
  return class BootGuardConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

interface Boot {
  readonly env: string;
  readonly store: 'MemorySessionStore' | 'SharedTestStore';
  readonly allowMemoryStore?: boolean;
}

const open: IContainer[] = [];

/** The real DefaultAuthnService and DefaultSessionIssuer in a child container, over kit fakes for the other neighbours. */
async function resolveAuthn(boot: Boot): Promise<void> {
  const session: Record<string, unknown> = { service: boot.store };
  if (boot.allowMemoryStore !== undefined) session.allowMemoryStore = boot.allowMemoryStore;
  const values = {
    http: { cookie: { secret: strong() } },
    authn: { strategies: [], session, local: { pepper: { secret: null, version: 1 } }, mfa: { steps: [], encryptionKey: { secret: strong() } } },
  };
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of [AUTHN_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA]) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values, boot.env)).as(Configuration);
  await child.resolve(Configuration);

  const throttle = new MemoryAuthnThrottle();
  (throttle as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', throttle);
  bind(child, IdentityStore, 'KitIdentityStore', new FakeIdentityStore());
  bind(child, PrincipalFactory, 'KitPrincipalFactory', new RecordingPrincipalFactory());
  child.register(SharedTestStore).as(SessionProvider);

  await child.resolve(AuthnService);
}

describe('the session store boot guard', function () {
  this.timeout(30000);

  afterEach(async () => {
    for (const child of open.splice(0)) await child.dispose();
  });

  it('refuses MemorySessionStore in production, naming the flag and the durable store', async () => {
    let error: unknown;
    try {
      await resolveAuthn({ env: 'production', store: 'MemorySessionStore' });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.include('authn.session.allowMemoryStore').and.include('session-provider-db');
  });

  it('refuses MemorySessionStore in an env that is neither development nor test', async () => {
    for (const env of ['staging', 'prod']) {
      let error: unknown;
      try {
        await resolveAuthn({ env, store: 'MemorySessionStore' });
      } catch (e) {
        error = e;
      }
      expect(error, env).to.be.instanceOf(InvalidOption);
    }
  });

  it('refuses MemorySessionStore in production when the flag is explicitly false', async () => {
    let error: unknown;
    try {
      await resolveAuthn({ env: 'production', store: 'MemorySessionStore', allowMemoryStore: false });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
  });

  it('boots MemorySessionStore in production with authn.session.allowMemoryStore', async () => {
    await resolveAuthn({ env: 'production', store: 'MemorySessionStore', allowMemoryStore: true });
  });

  it('boots MemorySessionStore in development and test without the flag', async () => {
    await resolveAuthn({ env: 'development', store: 'MemorySessionStore' });
    await resolveAuthn({ env: 'test', store: 'MemorySessionStore' });
  });

  it('boots a store that is not process memory in production', async () => {
    await resolveAuthn({ env: 'production', store: 'SharedTestStore' });
  });
});
