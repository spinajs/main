import { Bool, Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { SerializedError, WorkflowStatus } from '../contract.js';
import { WORKFLOW_CONNECTION } from '../workflow-config.js';
import { Int8 } from './converters.js';

@Connection(WORKFLOW_CONNECTION)
@Model('__workflow')
export class WorkflowInstanceModel extends ModelBase {
  @Primary()
  public Id: string;

  public Workflow: string;

  public Version: number;

  public Status: WorkflowStatus;

  public Reason: string | null;

  @Json()
  public Input: unknown;

  @Json()
  public Result: unknown;

  @Json()
  public Error: SerializedError | null;

  @Int8()
  public WakeAt: number | null;

  public WaitingFor: string | null;

  public Attempt: number;

  public ClaimedBy: string | null;

  @Int8()
  public ClaimedUntil: number | null;

  public ClaimEpoch: number;

  @Bool()
  public CancelRequested: boolean;

  @Int8()
  public CreatedAt: number;

  @Int8()
  public UpdatedAt: number;

  @Int8()
  public FinishedAt: number | null;
}
