import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** One principal's use of an invitation; the table keys (invitation_id, principal) with a unique index. */
@Connection('default')
@Model('team_invitation_uses')
export class TeamInvitationUse extends ModelBase<TeamInvitationUse> {
  @Primary({ generated: 'assigned' })
  public invitation_id: string;

  @Primary({ generated: 'assigned' })
  public principal: string;

  @DT()
  public used_at: DateTime;
}
