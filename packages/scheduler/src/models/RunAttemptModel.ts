import { Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { RunStatus, StructuredError } from '../contract.js';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler_run_attempt')
export class RunAttemptModel extends ModelBase {
  @Primary()
  public Id: number;

  public RunId: string;

  public Attempt: number;

  @EpochMs()
  public StartedAt: number;

  @EpochMs()
  public FinishedAt: number | null;

  public Status: RunStatus;

  @Json()
  public Error: StructuredError | null;
}
