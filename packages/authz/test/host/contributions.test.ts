import * as chai from 'chai';
import 'mocha';
import { Container } from '@spinajs/di';

import { AuthzConfigError, AuthzContributor, collectContributions, resolveChain } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';

const expect = chai.expect;

abstract class Plugin {
  abstract readonly id: string;
}

class Fixed extends AuthzContributor {
  constructor(private readonly answer: () => unknown) {
    super();
  }

  contribute(): AuthzContribution {
    return this.answer() as AuthzContribution;
  }
}

describe('resolveChain', () => {
  it('Array.chainOf of an unregistered abstract resolves to [] and registers nothing', async () => {
    const container = new Container();
    expect([...(await container.resolve(Array.chainOf(Plugin)))]).to.deep.equal([]);
    expect(container.hasRegistered(Plugin)).to.equal(false);
    expect(await resolveChain(container, Plugin)).to.deep.equal([]);
    expect(container.hasRegistered(Plugin)).to.equal(false);
  });

  it('gives the registrations of the container chain, ancestors first, and sees a late registration', async () => {
    const parent = new Container();
    const child = parent.child();
    parent.register(() => ({ id: 'p' })).as(Plugin);
    expect((await resolveChain(child, Plugin)).map((p) => p.id)).to.deep.equal(['p']);
    child.register(() => ({ id: 'c' })).as(Plugin);
    expect((await resolveChain(child, Plugin)).map((p) => p.id)).to.deep.equal(['p', 'c']);
  });
});

describe('collectContributions', () => {
  const containerOf = (...answers: (() => unknown)[]) => {
    const c = new Container();
    for (const answer of answers) c.register(() => new Fixed(answer)).as(AuthzContributor);
    return c;
  };

  it('asks every contributor of the chain for the domain', async () => {
    const seen: string[] = [];
    const c = new Container();
    c.register(() => ({ contribute: (d: string) => (seen.push(d), { joinTypes: ['a'] }) })).as(AuthzContributor);
    c.register(() => ({ contribute: async () => ({ joinTypes: ['b'] }) })).as(AuthzContributor);
    expect(await collectContributions(c, 'tenant', 'here')).to.deep.equal([{ joinTypes: ['a'] }, { joinTypes: ['b'] }]);
    expect(seen).to.deep.equal(['tenant']);
  });

  it('gives [] when no contributor is registered', async () => {
    expect(await collectContributions(new Container(), 'root', 'here')).to.deep.equal([]);
  });

  it('wraps a throwing contributor', async () => {
    const boom = new Error('boom');
    const err = await collectContributions(
      containerOf(() => {
        throw boom;
      }),
      'root',
      'here',
    ).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.equal('here: contributor "Fixed" failed: boom');
    expect((err as Error).cause).to.equal(boom);
  });

  it('refuses an answer that is not an object', async () => {
    const err = await collectContributions(containerOf(() => 7), 'root', 'here').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.equal('here: contributor "Fixed" returned 7 instead of an object');
  });

  it('refuses a contribution key that is not an array', async () => {
    const err = await collectContributions(containerOf(() => ({ scopeAttributeSchemas: {} })), 'root', 'here').catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.equal('here: the scopeAttributeSchemas of contributor "Fixed" must be an array');
  });
});
