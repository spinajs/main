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
}
