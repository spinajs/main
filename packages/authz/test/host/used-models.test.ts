import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { StaticModel } from '@spinajs/authz-testing';
import { AuthzConfigError, resolveUsedModels } from '@spinajs/authz';
import { installHost, registerInRoot, resetHost, uninstallHost } from './support.js';

const expect = chai.expect;
const KEY = 'authz.domains.kid.use';
const WHERE = 'Authz domain "kid"';
const silent = (name: string) => new StaticModel({ name });

async function refusal(names: string[]): Promise<Error> {
  const c = DI.RootContainer.child();
  try {
    await resolveUsedModels(c, names, KEY, WHERE);
  } catch (e) {
    return e as Error;
  } finally {
    await c.dispose();
  }
  throw new Error('expected a refusal');
}

describe('resolveUsedModels', function () {
  this.timeout(10000);
  before(installHost);
  after(uninstallHost);
  afterEach(resetHost);

  it('resolves each name in the given container, in the listed order', async () => {
    registerInRoot('a', () => silent('a'));
    registerInRoot('b', () => silent('b'));
    const c = DI.RootContainer.child();
    try {
      expect((await resolveUsedModels(c, ['b', 'a'], KEY, WHERE)).map((m) => m.name)).to.deep.equal(['b', 'a']);
    } finally {
      await c.dispose();
    }
  });

  it('runs a factory in the container it resolves in, once per call', async () => {
    const seen: IContainer[] = [];
    registerInRoot('a', (container: IContainer) => {
      seen.push(container);
      return silent('a');
    });
    const c = DI.RootContainer.child();
    try {
      const [first] = await resolveUsedModels(c, ['a'], KEY, WHERE);
      const [second] = await resolveUsedModels(c, ['a'], KEY, WHERE);
      expect(seen).to.deep.equal([c, c]);
      expect(first).to.not.equal(second);
    } finally {
      await c.dispose();
    }
  });

  it('refuses a name nothing is registered under', async () => {
    const err = await refusal(['ghost']);
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.equal(`${WHERE}: ${KEY} lists "ghost", but nothing is registered under that name; is the package that provides it loaded?`);
  });

  it('refuses a name registered more than once', async () => {
    registerInRoot('a', () => silent('a'));
    registerInRoot('a', () => silent('a'));
    expect((await refusal(['a'])).message).to.equal(`${WHERE}: ${KEY} lists "a", which is registered 2 times`);
  });

  it('refuses a value that is not a model', async () => {
    registerInRoot('a', () => ({ name: 'a' }));
    expect((await refusal(['a'])).message).to.equal(`${WHERE}: ${KEY} lists "a", which resolves to Object, not an AuthorizationModel`);
  });

  it('refuses a model registered under a name other than its own', async () => {
    registerInRoot('a', () => silent('b'));
    expect((await refusal(['a'])).message).to.equal(`${WHERE}: ${KEY} lists "a", which resolves to a model named "b"; register a model under its own name`);
  });
});
