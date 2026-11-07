import { Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import { IDEMPOTENCY_CONNECTION, IDEMPOTENCY_TABLE } from '../connection.js';
import type { StoredReply } from '../interfaces.js';

/** BIGINT columns come back as strings on Postgres; OrmIdempotencyStore reads them with Number(). */
@Connection(IDEMPOTENCY_CONNECTION)
@Model(IDEMPOTENCY_TABLE)
export class IdempotencyKeyModel extends ModelBase<IdempotencyKeyModel> {
  @Primary({ generated: 'assigned' })
  public Key!: string;

  public Namespace!: string;

  public Fingerprint!: string | null;

  public State!: 'running' | 'done';

  public Token!: string;

  public LeaseUntil!: number;

  @Json()
  public Reply!: StoredReply | null;

  public ExpiresAt!: number | null;

  public CreatedAt!: number;
}
