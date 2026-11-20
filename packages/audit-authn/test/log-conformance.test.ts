import 'mocha';
import { AuthenticationStrategy, AuthnService, AuthnThrottle, IdentityStore, MemoryAuthnThrottle, PasswordCredentialStore, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthenticationResult, AuthnContext, Credentials, Principal, SessionHandle } from '@spinajs/authn';
import { FakeIdentityStore, FakeStrategy, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Harness, HarnessContext } from '@spinajs/authn-testing';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, NewInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';

import { AuthnAuditRecorder } from '../src/index.js';

const STRATEGY = 'KitPasswordStrategy';

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = (): unknown => value;
  // DI keys a registration by its function name.
  Object.defineProperty(factory, 'name', { value: name });
  child.register(factory).as(base);
}

// Every line of the case running now, whichever logger wrote it; `@Logger` resolves from the root, so LineLog is registered there.
const lines: string[] = [];

/** A Log per resolve that renders every line into `lines`. */
@NewInstance()
class LineLog {
  constructor(readonly Name: string = '') {}

  trace(first: unknown, ...rest: unknown[]): void {
    this.write('trace', first, rest);
  }

  debug(first: unknown, ...rest: unknown[]): void {
    this.write('debug', first, rest);
  }

  info(first: unknown, ...rest: unknown[]): void {
    this.write('info', first, rest);
  }

  warn(first: unknown, ...rest: unknown[]): void {
    this.write('warn', first, rest);
  }

  error(first: unknown, ...rest: unknown[]): void {
    this.write('error', first, rest);
  }

  warnOnce(_key: string, first: unknown, ...rest: unknown[]): boolean {
    this.write('warn', first, rest);
    return true;
  }

  // The Log overloads: (message, ...args) or (fields, message?, ...args).
  private write(level: string, first: unknown, rest: unknown[]): void {
    const fields = first !== null && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
    const template = rest[0];
    const message = fields ? renderTemplate(typeof template === 'string' ? template : '', fields) : String(first);
    lines.push(`${level} ${this.Name} ${message}`);
  }
}

function appConfiguration(audit: Record<string, unknown>): Class<Configuration> {
  return class LogTrailConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }

    protected onLoad(): unknown {
      return { authn: { strategies: [{ name: 'local', service: STRATEGY }] }, audit };
    }
  };
}

/** Writes out the recorder's buffer after each login, so a case reads the lines its logins caused. */
class FlushingAuthnService extends AuthnService {
  constructor(private readonly inner: AuthnService, private readonly recorder: AuthnAuditRecorder) {
    super();
  }

  async authenticate(c: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    try {
      return await this.inner.authenticate(c, ctx);
    } finally {
      await this.recorder.flush();
    }
  }

  completeMfa(pending: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    return this.inner.completeMfa(pending, step, response, ctx);
  }

  reauthenticate(session: SessionHandle, c: Credentials, ctx: AuthnContext): Promise<boolean> {
    return this.inner.reauthenticate(session, c, ctx);
  }

  stepUp(session: SessionHandle, step: string, response: string, ctx: AuthnContext): Promise<AuthenticationResult> {
    return this.inner.stepUp(session, step, response, ctx);
  }

  principalOf(result: Extract<AuthenticationResult, { status: 'success' }>): Promise<Principal> {
    return this.inner.principalOf(result);
  }

  strategies(): ReturnType<AuthnService['strategies']> {
    return this.inner.strategies();
  }
}

/** The real DefaultAuthnService and AuthnAuditRecorder, recording into a LogAuditStore trail; `logs` is every line logged during the case. */
const logTrailHarness =
  (audit: Record<string, unknown>) =>
  async (ctx: HarnessContext): Promise<Harness> => {
    if (Object.keys(ctx.config).length > 0) throw new UnsupportedConfig(Object.keys(ctx.config));
    const identities = new FakeIdentityStore();
    const passwords = new MemoryPasswordCredentialStore();
    lines.length = 0;
    const child = DI.RootContainer.child();
    try {
      child.register(appConfiguration(audit)).as(Configuration);
      child.register(MemoryAuthnThrottle).as(AuthnThrottle);
      bind(child, IdentityStore, 'KitIdentityStore', identities);
      bind(child, PasswordCredentialStore, 'KitPasswordCredentialStore', passwords);
      bind(child, PrincipalFactory, 'KitPrincipalFactory', new RecordingPrincipalFactory());
      bind(child, SessionIssuer, 'KitSessionIssuer', new MemorySessionIssuer());
      bind(child, AuthenticationStrategy, STRATEGY, FakeStrategy.password({ identities, passwords }));
      await child.resolve(Configuration);
      const service = new FlushingAuthnService(await child.resolve(AuthnService), await child.resolve(AuthnAuditRecorder));
      return { service, seed: fakeSeedPort(identities, passwords), logs: { lines: () => [...lines] }, dispose: () => child.dispose() };
    } catch (e) {
      await child.dispose();
      throw e;
    }
  };

describe('audit-authn conformance', function () {
  this.timeout(60_000);

  before(() => DI.register(LineLog).as(Log));

  after(() => DI.unregister(Log, LineLog));

  runAuthnBehaviour(['A21'], logTrailHarness({}), { title: 'A21/log: the built-in security trail', facets: ['A21/log'], claim: ['A21/log'] });

  runAuthnBehaviour(['A21'], logTrailHarness({ trails: { plain: { store: 'LogAuditStore', hash: [] } }, authn: { trail: 'plain' } }), {
    title: 'A21/log: a log trail with an empty hash list',
    facets: ['A21/log'],
    claim: ['A21/log'],
  });
});
