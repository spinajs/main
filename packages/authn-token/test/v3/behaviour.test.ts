import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { RawQuery } from '@spinajs/orm';
import { UnsupportedConfig, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { HarnessContext } from '@spinajs/authn-testing';

import { bootV3Db, shutdownV3Db, v3Connection } from './db.js';
import { jwtHarness, tokenHarness } from './harness.js';

describe('authn-token behaviour', function () {
  before(async function () {
    this.timeout(15000);
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  // The harness has no `service` port, so A15/core (N8a's facet) stays pending here.
  runAuthnBehaviour(['A14', 'A15'], tokenHarness, { title: 'authn-token: A14, A15', claim: ['A14/token', 'A15/token'] });

  runAuthnBehaviour(['A16'], jwtHarness, { title: 'authn-token: A16', claim: ['A16/jwt'] });

  it('jwtHarness refuses config it cannot apply and leaves the issuers as they were when the strategy fails boot', async () => {
    const path = ['authn', 'jwt', 'issuers'];
    const configuration = DI.get(Configuration)!;
    const before = configuration.get(path);

    const unsupported = await jwtHarness({ config: { authn: { token: { maxTtlDays: 7 } } } } as unknown as HarnessContext).catch((e: unknown) => e);
    expect(unsupported).to.be.instanceOf(UnsupportedConfig);
    expect((unsupported as UnsupportedConfig).keys).to.deep.equal(['authn.token.maxTtlDays']);

    const refused = await jwtHarness({ config: { authn: { jwt: { issuers: [{ issuer: 'https://idp.test', audience: 'api', jwksUri: 'http://idp.test/jwks.json', algorithms: ['EdDSA'] }] } } } } as unknown as HarnessContext).catch((e: unknown) => e);
    expect(refused).to.be.instanceOf(Error);
    expect(configuration.get(path)).to.equal(before);
  });

  it('tokenHarness leaves the config as it was when its setup fails', async () => {
    const path = ['authn', 'token', 'maxTtlDays'];
    const configuration = DI.get(Configuration)!;
    const before = configuration.get(path);
    const schema = () => v3Connection().schema();

    await schema().raw(new RawQuery('ALTER TABLE rbac_access_tokens RENAME TO rbac_access_tokens_away'));
    try {
      const err = await tokenHarness({ config: { authn: { token: { maxTtlDays: 7 } } } } as unknown as HarnessContext).catch((e: unknown) => e);
      expect(err).to.be.instanceOf(Error);
    } finally {
      await schema().raw(new RawQuery('ALTER TABLE rbac_access_tokens_away RENAME TO rbac_access_tokens'));
    }

    expect(configuration.get(path)).to.equal(before);
  });
});
