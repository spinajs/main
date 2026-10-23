import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import type { IWhereBuilder, QueryScope } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { UPLOAD_BLOBS_TABLE, UPLOAD_CONNECTION } from '../constants.js';

export type BlobKind = 'part' | 'file';
export type BlobState = 'writing' | 'live' | 'garbage';

export class UploadBlobScopes implements QueryScope {
  public ofSession<B extends IWhereBuilder<UploadBlob> & UploadBlobScopes>(this: B, sessionId: string): B {
    return this.where('session_id', sessionId);
  }

  public inState<B extends IWhereBuilder<UploadBlob> & UploadBlobScopes>(this: B, state: BlobState): B {
    return this.where('state', state);
  }

  public updatedBefore<B extends IWhereBuilder<UploadBlob> & UploadBlobScopes>(this: B, at: DateTime): B {
    return this.where('updated_at', '<', at);
  }
}

/** Every object the upload writes, recorded before writing starts; cleanup reads these rows and never lists storage (spec D13). */
@Connection(UPLOAD_CONNECTION)
@Model(UPLOAD_BLOBS_TABLE)
export class UploadBlob extends ModelBase<UploadBlob> {
  public static readonly _queryScopes: UploadBlobScopes = new UploadBlobScopes();

  @Primary({ generated: 'assigned' })
  public id: string;

  public session_id: string;

  public fs: string;

  public key: string;

  public kind: BlobKind;

  public state: BlobState;

  @DT()
  public created_at: DateTime;

  @DT()
  public updated_at: DateTime;
}
