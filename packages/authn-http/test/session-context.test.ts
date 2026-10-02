import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';

import { SessionContextProvider, sessionContextProperties } from '../src/session-context.js';
import { ActiveRoleResponseSchema, UserWithGrantsSchema, WhoamiResponseSchema } from '../src/dto/auth-responses.js';

class PoolContext extends SessionContextProvider {
  public static Properties = { Pool: { type: 'string', nullable: true } };

  public resolve() {
    return { Pool: null };
  }
}

describe('SessionContextProvider schemas', () => {
  afterEach(() => {
    DI.unregister(PoolContext);
  });

  it('contributes nothing while no provider is registered', () => {
    expect(sessionContextProperties()).to.deep.equal({});
    expect(ActiveRoleResponseSchema.properties).to.have.all.keys('ActiveRole', 'Grants');
  });

  // The schemas are registered when the module loads, before any application provider is.
  it('publishes the properties of a provider registered after the schemas', () => {
    DI.register(PoolContext).as(SessionContextProvider);

    for (const schema of [UserWithGrantsSchema, ActiveRoleResponseSchema, WhoamiResponseSchema]) {
      expect(schema.properties, schema.title).to.have.property('Pool');
    }
  });
});
