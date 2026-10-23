import { Connection, DateTime as DT, Int64, Model, ModelBase, Primary } from '@spinajs/orm';
import type { IWhereBuilder, QueryScope } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { UPLOAD_CONNECTION, UPLOAD_PARTS_TABLE } from '../constants.js';

export class UploadPartScopes implements QueryScope {
  public ofSession<B extends IWhereBuilder<UploadPart> & UploadPartScopes>(this: B, sessionId: string): B {
    return this.where('session_id', sessionId);
  }
}

@Connection(UPLOAD_CONNECTION)
@Model(UPLOAD_PARTS_TABLE)
export class UploadPart extends ModelBase<UploadPart> {
  public static readonly _queryScopes: UploadPartScopes = new UploadPartScopes();

  @Primary({ generated: 'assigned' })
  public session_id: string;

  @Primary({ generated: 'assigned' })
  public number: number;

  @Int64('number')
  public size: number;

  public sha256: string;

  public storage_key: string;

  /** Part 1 only: the content check reads the head of the file. */
  public detected_mime: string | null;

  @DT()
  public received_at: DateTime;
}
