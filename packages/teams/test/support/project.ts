import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

/** An app resource owned by a team, as an app declares one. */
@Connection('default')
@Model('test_projects')
@AccessResource('project')
export class TestProject extends ModelBase<TestProject> {
  @Primary()
  public id: string;

  @Parent('team')
  public team_id: string;

  public name: string;
}
