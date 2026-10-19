import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import { DefaultSessionIssuer } from '../src/index.js';
import type { ISession, SessionProvider } from '../src/index.js';
import { SessionTestConfiguration, uncacheOwned, withSessionConfig } from './support.js';

const alice: IdentityRef = { type: 'user', id: 'alice' };
const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });

class ChildConfiguration extends SessionTestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { authn: { session: { pendingTtlSeconds: number } } }).authn.session.pendingTtlSeconds = 60;
  }
}

/** Seconds between issue and expiry of the pending session `h`, read from the issuer's own store. */
function pendingTtlOf(issuer: SessionIssuer, h: SessionHandle): number {
  const store = (issuer as unknown as { Store: SessionProvider }).Store;
  const row = (store as unknown as { Sessions: Map<string, ISession> }).Sessions.get(createHash('sha256').update(h.id).digest('hex'))!;
  return Math.round(row.Expiration!.diff(row.Creation).as('seconds'));
}

describe('DefaultSessionIssuer lifetime', () => {
  let child: IContainer | null = null;

  afterEach(async () => {
    await child?.dispose();
    child = null;
    uncacheOwned([DefaultSessionIssuer, SessionIssuer]);
  });

  it('a child container gets its own issuer, which reads the child configuration', async () => {
    await withSessionConfig({ authn: { session: { pendingTtlSeconds: 300 } } }, [DefaultSessionIssuer, SessionIssuer]);
    const rootIssuer = await DI.resolve(SessionIssuer);

    child = DI.RootContainer.child();
    child.register(ChildConfiguration).as(Configuration);
    await child.resolve(Configuration);
    const childIssuer = await child.resolve(SessionIssuer);

    expect(childIssuer).to.be.instanceOf(DefaultSessionIssuer);
    expect(childIssuer).to.not.equal(rootIssuer);
    expect(pendingTtlOf(childIssuer, await childIssuer.issue(alice, facts(), { pending: { steps: ['totp'] } }))).to.equal(60);
    expect(pendingTtlOf(rootIssuer, await rootIssuer.issue(alice, facts(), { pending: { steps: ['totp'] } }))).to.equal(300);
  });
});
