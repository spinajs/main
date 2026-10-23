import { Connection, DateTime as DT, Int64, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { IWhereBuilder, QueryScope } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { UPLOAD_CONNECTION, UPLOAD_SESSIONS_TABLE } from '../constants.js';
import type { FinalEventName, UploadStatus } from '../types.js';
import { NullableDateTime } from './converters.js';

export class UploadSessionScopes implements QueryScope {
  /** `null` leaves the query unscoped: an app without owners. */
  public ofOwner<B extends IWhereBuilder<UploadSession> & UploadSessionScopes>(this: B, owner: string | null): B {
    return owner === null ? this : this.where('owner', owner);
  }

  public open<B extends IWhereBuilder<UploadSession> & UploadSessionScopes>(this: B): B {
    return this.where('status', 'open');
  }

  public expiredBefore<B extends IWhereBuilder<UploadSession> & UploadSessionScopes>(this: B, at: DateTime): B {
    return this.where('expires_at', '<=', at);
  }
}

/** Read model of upload_sessions. Never saved: every state change is a conditional update in UploadStore (spec §5). */
@Connection(UPLOAD_CONNECTION)
@Model(UPLOAD_SESSIONS_TABLE)
export class UploadSession extends ModelBase<UploadSession> {
  public static readonly _queryScopes: UploadSessionScopes = new UploadSessionScopes();

  @Primary({ generated: 'assigned' })
  public id: string;

  public owner: string | null;

  public name: string;

  @Int64('number')
  public size: number;

  @Int64('number')
  public part_size: number;

  public part_count: number;

  public declared_sha256: string | null;

  public declared_mime: string | null;

  public detected_mime: string | null;

  public status: UploadStatus;

  @Json()
  public metadata: Record<string, unknown>;

  public temp_fs: string;

  public files_fs: string;

  public file_key: string | null;

  public sha256: string | null;

  public claim_token: string | null;

  @NullableDateTime()
  public claimed_at: DateTime | null;

  public failure_code: string | null;

  public failure_message: string | null;

  @DT()
  public created_at: DateTime;

  @DT()
  public updated_at: DateTime;

  @DT()
  public expires_at: DateTime;

  @NullableDateTime()
  public completed_at: DateTime | null;

  @NullableDateTime()
  public handled_at: DateTime | null;

  public final_event: FinalEventName | null;

  @NullableDateTime()
  public final_event_at: DateTime | null;
}
