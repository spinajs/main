import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { StaticModel } from '@spinajs/authz-testing';
import { AuthorizationModel, AuthzConfigError, modelCatalog, resolveListedModels } from '@spinajs/authz';
import { installHost, instance, named, registerInRoot, resetHost, uninstallHost } from './support.js';

const expect = chai.expect;
const KEY = 'authz.domains.kid.models';
const WHERE = 'Authz domain "kid"';
const silent = (name: string) => new StaticModel({ name });

/** A model class DI builds itself, as an app's own model would be. */
class ClassModel extends StaticModel {
  constructor() {
    super({ name: 'class-model' });
  }
}

async function inChild<T>(fn: (c: IContainer) => Promise<T>): Promise<T> {
  const c = DI.RootContainer.child();
  try {
    return await fn(c);
  } finally {
    await c.dispose();
  }
}

async function refusal(names: string[]): Promise<Error> {
  try {
    await inChild((c) => resolveListedModels(c, names, KEY, WHERE));
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a refusal');
}

describe('resolveListedModels', function () {
  this.timeout(10000);
  before(installHost);
  after(uninstallHost);
  afterEach(resetHost);

  it('finds a class by its class name and a factory by its function name, in the listed order', async () => {
    registerInRoot(AuthorizationModel, ClassModel);
    registerInRoot(AuthorizationModel, named('Second', instance(silent('second'))));
    const models = await inChild((c) => resolveListedModels(c, ['Second', 'ClassModel'], KEY, WHERE));
    expect(models.map((m) => m.name)).to.deep.equal(['second', 'class-model']);
    expect(models[1]).to.be.instanceOf(ClassModel);
  });

  it('calls a factory with the container it resolves in, once per call', async () => {
    const seen: IContainer[] = [];
    const Tracked = (container: IContainer) => {
      seen.push(container);
      return silent('tracked');
    };
    registerInRoot(AuthorizationModel, Tracked);
    await inChild(async (c) => {
      const [first] = await resolveListedModels(c, ['Tracked'], KEY, WHERE);
      const [second] = await resolveListedModels(c, ['Tracked'], KEY, WHERE);
      expect(seen).to.deep.equal([c, c]);
      expect(first).to.not.equal(second);
    });
  });

  it('leaves an anonymous factory out of the catalog', async () => {
    registerInRoot(AuthorizationModel, instance(silent('anon')));
    registerInRoot(AuthorizationModel, ClassModel);
    expect([...modelCatalog(DI.RootContainer).keys()]).to.deep.equal(['ClassModel']);
  });

  it('lets a registration lower in the lineage replace an ancestor one of the same name', async () => {
    registerInRoot(AuthorizationModel, named('Shared', instance(silent('from-root'))));
    await inChild(async (c) => {
      c.register(named('Shared', instance(silent('from-child')))).as(AuthorizationModel);
      const [model] = await resolveListedModels(c, ['Shared'], KEY, WHERE);
      expect(model.name).to.equal('from-child');
    });
  });

  it('refuses a name nothing is registered under, listing the registered names', async () => {
    registerInRoot(AuthorizationModel, ClassModel);
    const err = await refusal(['Ghost']);
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.equal(`${WHERE}: ${KEY} lists "Ghost", but no class or named factory of that name is registered under AuthorizationModel (registered: ClassModel); is the package that provides it loaded?`);
  });

  it('refuses a name registered twice in one container', async () => {
    registerInRoot(AuthorizationModel, named('Twice', instance(silent('a'))));
    registerInRoot(AuthorizationModel, named('Twice', instance(silent('b'))));
    expect((await refusal(['Twice'])).message).to.equal(`${WHERE}: ${KEY} lists "Twice", which is registered 2 times`);
  });

  it('refuses a factory that does not give a model', async () => {
    registerInRoot(AuthorizationModel, named('NotAModel', () => ({ name: 'x' }) as unknown as AuthorizationModel));
    expect((await refusal(['NotAModel'])).message).to.equal(`${WHERE}: ${KEY} lists "NotAModel", which resolves to Object, not an AuthorizationModel`);
  });
});
