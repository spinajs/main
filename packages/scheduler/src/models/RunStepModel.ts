import { Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { StepStatus, StructuredError } from '../contract.js';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler_run_step')
export class RunStepModel extends ModelBase {
  @Primary()
  public Id: number;

  public RunId: string;

  public Attempt: number;

  public Seq: number;

  public Name: string;

  public Status: StepStatus;

  public Weight: number;

  @EpochMs()
  public StartedAt: number;

  @EpochMs()
  public FinishedAt: number | null;

  public Progress: number;

  public Done: number | null;

  public Total: number | null;

  public Message: string | null;

  @Json()
  public Result: unknown;

  @Json()
  public Error: StructuredError | null;
}
