import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, ServiceNotFound } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { resolveNamedServices } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

abstract class Guard {
  public abstract readonly name: string;
}

class TokenGuard extends Guard {
  public readonly name = 'token';
}

class SessionGuard extends Guard {
  public readonly name = 'session';
}

describe('config-listed services with an unknown service', () => {
  const containers: IContainer[] = [];

  const child = (parent: IContainer, guards: unknown) => {
    const c = parent.child();
    c.register(NoSource).as(ConfigurationSource);
    c.register(configurationOf({ http: { guards } })).as(Configuration);
    containers.push(c);
    return c;
  };

  const rejectionOf = async (c: IContainer) => {
    await c.resolve(Configuration);
    return resolveNamedServices(c, 'http.guards', Guard, { lineage: true, keyBy: 'name' }).then(
      () => undefined,
      (e: unknown) => e,
    );
  };

  afterEach(async () => {
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  it('names the services registered across the lineage', async () => {
    const root = child(DI.RootContainer, []);
    root.register(TokenGuard).as(Guard);
    const c = child(root, [{ name: 'basic', service: 'BasicGuard' }]);
    c.register(SessionGuard).as(Guard);

    const error = await rejectionOf(c);

    expect(error).to.be.instanceOf(ServiceNotFound);
    expect((error as Error).message).to.equal('http.guards entry "basic": no Guard is registered as service "BasicGuard" (registered: "TokenGuard", "SessionGuard")');
  });

  it('says none when no service of the type is registered', async () => {
    const c = child(DI.RootContainer, [{ name: 'basic', service: 'BasicGuard' }]);

    const error = await rejectionOf(c);

    expect(error).to.be.instanceOf(ServiceNotFound);
    expect((error as Error).message).to.equal('http.guards entry "basic": no Guard is registered as service "BasicGuard" (registered: none)');
  });
});
