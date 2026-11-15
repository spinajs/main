import { Bool, Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { SerializedError, StepKind, StepMeta, StepStatus } from '../contract.js';
import { WORKFLOW_CONNECTION } from '../workflow-config.js';
import { Int8 } from './converters.js';

@Connection(WORKFLOW_CONNECTION)
@Model('__workflow_step')
export class WorkflowStepModel extends ModelBase {
  @Primary()
  public Id: number;

  public InstanceId: string;

  public Seq: number;

  public Key: string;

  public Kind: StepKind;

  public Status: StepStatus;

  public Attempt: number;

  @Json()
  public Result: unknown;

  /** `Result` holds the step's value; `false` replays as `undefined`. */
  @Bool()
  public ResultStored: boolean;

  @Json()
  public Error: SerializedError | null;

  @Json()
  public Meta: StepMeta | null;

  @Int8()
  public StartedAt: number;

  @Int8()
  public FinishedAt: number | null;
}
