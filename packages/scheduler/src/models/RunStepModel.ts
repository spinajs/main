import { Bool, Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import type { StepStatus, StructuredError } from '../contract.js';
import { Decimal, EpochMs, JsonText } from './converters.js';

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

  @Decimal()
  public Weight: number;

  @EpochMs()
  public StartedAt: number;

  @EpochMs()
  public FinishedAt: number | null;

  public Progress: number;

  @Decimal()
  public Done: number | null;

  @Decimal()
  public Total: number | null;

  public Message: string | null;

  @JsonText()
  public Result: unknown;

  /** `Result` holds the step's return value; a resumed run re-runs steps without one. */
  @Bool()
  public ResultStored: boolean;

  @JsonText()
  public Error: StructuredError | null;
}
