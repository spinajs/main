import { BelongsTo, Connection, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { TestClient } from './TestClient.js';

/**
 * Parent model ( no rbac resource ) populating TestClient as a BelongsTo relation -
 * mirrors the campaign -> client use case.
 */
@Connection('default')
@Model('test_campaign')
export class TestCampaign extends ModelBase {
  @Primary()
  public Id: number;

  @BelongsTo(TestClient, 'client_id')
  public Client: SingleRelation<TestClient>;

  // second relation to the same model - populating both is what surfaces the alias collision
  @BelongsTo(TestClient, 'agency_id')
  public Agency: SingleRelation<TestClient>;
}
