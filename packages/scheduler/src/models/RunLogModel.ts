import { Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { RunEventPayload } from '../contract.js';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler_run_log')
export class RunLogModel extends ModelBase {
  @Primary()
  public Id: number;

  public RunId: string;

  public Schedule: string;

  public Seq: number;

  public Attempt: number;

  @EpochMs()
  public Ts: number;

  public Kind: string;

  public Level: string | null;

  public Step: string | null;

  public Message: string | null;

  @Json()
  public Data: RunEventPayload;

  /** Global position, commit-ordered across replicas (R15); written only by appendJournalRow(). */
  public Pos: number;
}
