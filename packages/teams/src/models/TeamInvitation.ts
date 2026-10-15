import { Connection, CreatedAt, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { NullableDateTime } from './converters.js';

@Connection('default')
@Model('team_invitations')
export class TeamInvitation extends ModelBase<TeamInvitation> {
  @Primary()
  public id: string;

  public team_id: string;

  public group_id: string | null;

  public role: string;

  public email: string | null;

  public token_hash: string;

  public max_uses: number | null;

  public uses: number;

  @DT()
  public expires_at: DateTime;

  @NullableDateTime()
  public revoked_at: DateTime | null;

  public created_by: string;

  @CreatedAt()
  public created_at: DateTime;

  @NullableDateTime()
  public last_sent_at: DateTime | null;
}
