import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, OrmNotFoundException } from '@spinajs/orm';
import { TestConfiguration } from './common.js';
import { RelationResolverHydrator } from './../src/dto-relation.js';
import { CampaignDTO } from './dto/CampaignDTO.js';
import { Campaign } from './models/Campaign.js';
import { User } from './models/User.js';
import './migrations/DtoRelation_2026_07_23_00_00_00.js';
import '@spinajs/log';
import 'mocha';
import { expect } from 'chai';

describe('DTO @Relation resolution (orm integration)', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) { await b.bootstrap(); }
    await DI.resolve(Orm); // auto-runs migrations, incl. users + campaign
  });

  const resolveDto = (input: any): Promise<CampaignDTO> => {
    const hydrator = new RelationResolverHydrator();
    return hydrator.hydrate(input, { RuntimeType: CampaignDTO } as any);
  };

  it('resolves a relation field to the model instance', async () => {
    const dto = await resolveDto({ Name: 'x', author: 'user-uuid-1' });
    expect(dto.author).to.be.instanceOf(User);
    expect((dto.author as unknown as User).Id).to.equal(100);
  });

  it('translates the resolved model to the FK column on update', async () => {
    const dto = await resolveDto({ Name: 'updated', author: 'user-uuid-1' });
    const campaign = await (Campaign as any).where({ Id: 1 }).firstOrFail();
    await campaign.update(dto);

    const reloaded = await (Campaign as any).where({ Id: 1 }).firstOrFail();
    expect((reloaded as any).author).to.equal(100);
    expect(reloaded.Name).to.equal('updated');
  });

  it('throws OrmNotFoundException when the referenced entity does not exist', async () => {
    let threw = false;
    try {
      await resolveDto({ author: 'does-not-exist' });
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(OrmNotFoundException);
    }
    expect(threw).to.equal(true);
  });

  it('leaves an absent optional relation field untouched', async () => {
    const dto = await resolveDto({ Name: 'name-only' });
    expect(dto.author).to.equal(undefined);
  });
});
