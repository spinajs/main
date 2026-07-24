import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { ICompilerOutput, Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';

import './migration/rbac.migration.js';
import { AsyncLocalStorage } from 'async_hooks';
import { ResourceModel } from './models/ResourceModel.js';
import { TestCampaign } from './models/TestCampaign.js';
import { TestClient } from './models/TestClient.js';
import { TestScope } from './models/TestScope.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('Orm rbac test', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  describe('Rbac', () => {
    it('should add statement on read:own permission', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      const result = await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['normal'],
          }),
        },
        async () => {
          return await ResourceModel.where('Id', '>', 0).first();
        },
      );

      expect(result).to.be.not.null;
    });

    it('should throw forbidden when user has no permission', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      await expect(
        store.run(
          {
            User: new User({
              Id: 1,
              Role: ['user'],
            }),
          },
          async () => {
            return await ResourceModel.where('Id', '>', 0).first();
          },
        ),
      ).to.be.rejectedWith('User does not have permission to access Test:read permission');
    });

    it('should skip rbac check when SkipModelPermissionCheck is set', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      const result = await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['user'],
          }),
          SkipModelPermissionCheck: true,
        },
        async () => {
          return await ResourceModel.where('Id', '>', 0).first();
        },
      );

      expect(result).to.be.not.null;
    });
  });

  describe('Rbac relationScope join', () => {
    it('should emit rbac constraint in relation JOIN ON clause, not in parent WHERE', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['normal'],
          }),
        },
        async () => {
          const result = TestCampaign.where('Id', '>', 0).populate('Client').toDB() as ICompilerOutput;

          // constraint from TestClient.rbac() must land in the LEFT JOIN ON clause
          expect(result.expression).to.match(/LEFT JOIN .*test_client.* ON .*`\$Client\$`\.`type` IN \(\?,\?\)/);

          // and must NOT leak into the parent query WHERE
          const wherePart = result.expression!.split('WHERE')[1];
          expect(wherePart).to.not.contain('type');
        },
      );
    });

    it('should still filter in WHERE on a root query', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['normal'],
          }),
        },
        async () => {
          const result = TestClient.where('Id', '>', 0).toDB() as ICompilerOutput;

          expect(result.expression).to.not.contain('JOIN');
          expect(result.expression).to.match(/WHERE .*`type` IN \(\?,\?\)/);
        },
      );
    });

    it('should combine rbac constraint with user whereOnJoin OR group in JOIN ON clause', async () => {
      const store = DI.resolve(AsyncLocalStorage);
      await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['normal'],
          }),
        },
        async () => {
          const result = TestCampaign.where('Id', '>', 0)
            .populate('Client', function () {
              this.whereOnJoin(function () {
                this.where(function () {
                  this.where('Name', 'Orange').orWhere('Name', 'T-Mobile');
                });
              });
            })
            .toDB() as ICompilerOutput;

          // rbac constraint AND the user OR group both land in the JOIN ON clause
          expect(result.expression).to.match(/ON .*`\$Client\$`\.`type` IN \(\?,\?\) AND \( `\$Client\$`\.`Name` = \? OR `\$Client\$`\.`Name` = \? \)/);

          // parent WHERE stays clean of relation conditions
          const wherePart = result.expression!.split('WHERE')[1];
          expect(wherePart).to.not.contain('type');
          expect(wherePart).to.not.contain('Name');
        },
      );
    });

    it('should give each join a distinct alias when one model is joined twice', async () => {
      // Two relations to the same client, each filtering the client by its scope (a JOIN to
      // test_scope). Both scope joins default to the same `$TestScope$` alias, which the
      // database rejects with "Not unique table/alias".
      const result = TestCampaign.where('Id', '>', 0)
        .populate('Client', function () {
          this.innerJoin('Scope', function () {
            this.whereIn('code', ['primespot']);
          });
        })
        .populate('Agency', function () {
          this.innerJoin('Scope', function () {
            this.whereIn('code', ['primespot']);
          });
        })
        .toDB() as ICompilerOutput;

      const aliases = [...result.expression!.matchAll(/as `([^`]+)`/g)].map((m) => m[1]);
      const duplicated = aliases.filter((a, i) => aliases.indexOf(a) !== i);

      expect(duplicated, `duplicate alias in:\n${result.expression}`).to.be.empty;
    });

    it('should not drop a parent whose relation is filtered by a joined table', async () => {
      // Client 1 sits in the 'yourscreen' scope; the relation filter allows only 'primespot'.
      // The campaign must still come back (with Client empty) - a relation constraint may not
      // decide which parent rows survive. An INNER JOIN in the relation drops the parent.
      await TestScope.insert(new TestScope({ Id: 1, code: 'primespot' }));
      await TestScope.insert(new TestScope({ Id: 2, code: 'yourscreen' }));

      await TestClient.insert(new TestClient({ Id: 1, type: 1, scope_id: 2 } as any));
      await TestCampaign.insert(new TestCampaign({ Id: 1, client_id: 1 } as any));

      const campaigns = await TestCampaign.where('Id', '>', 0).populate('Client', function () {
        this.innerJoin('Scope', function () {
          this.whereIn('code', ['primespot']);
        });
      });

      expect(campaigns.length).to.equal(1);
      expect(campaigns[0].Client?.Value).to.satisfy((v: unknown) => v === null || v === undefined);
    });

    it('should not drop campaigns whose client type is filtered out', async () => {
      // end-to-end: campaign with disallowed client type must stay in results with Client = null
      await TestClient.insert(new TestClient({ Id: 1, type: 1 }));
      await TestClient.insert(new TestClient({ Id: 2, type: 3 }));

      await TestCampaign.insert(new TestCampaign({ Id: 1, client_id: 1 } as any));
      await TestCampaign.insert(new TestCampaign({ Id: 2, client_id: 2 } as any));

      const store = DI.resolve(AsyncLocalStorage);
      await store.run(
        {
          User: new User({
            Id: 1,
            Role: ['normal'],
          }),
        },
        async () => {
          const campaigns = await TestCampaign.where('Id', '>', 0).populate('Client');

          // both campaigns visible - LEFT JOIN stays a LEFT JOIN
          expect(campaigns.length).to.equal(2);

          const allowed = campaigns.find((c) => c.Id === 1);
          const filtered = campaigns.find((c) => c.Id === 2);

          // allowed client type populated, disallowed comes back empty
          expect(allowed?.Client?.Value?.Id).to.equal(1);
          expect(filtered?.Client?.Value).to.satisfy((v: unknown) => v === null || v === undefined);
        },
      );
    });
  });
});
