import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { RawQuery } from '@spinajs/orm';
import { runAuthnBehaviour } from '@spinajs/authn-testing';
import type { HarnessContext } from '@spinajs/authn-testing';

import { bootV3Db, shutdownV3Db, v3Connection } from './db.js';
import { tokenHarness } from './harness.js';

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
