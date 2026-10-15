import { Bool, Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import type { RunStatus, RunTrigger, StructuredError, TriggeredBy } from '../contract.js';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler_run')
export class RunModel extends ModelBase {
  @Primary()
  public Id: string;

  public Schedule: string;

  public Trigger: RunTrigger;

  @Json()
  public TriggeredBy: TriggeredBy | null;

  public ParentRunId: string | null;

  @Json()
  public Params: Record<string, unknown> | null;

  public Status: RunStatus;

  public Reason: string | null;

  public Attempt: number;

  public MaxAttempts: number;

  @EpochMs()
  public NextAttemptAt: number | null;

  @EpochMs()
  public ScheduledAt: number | null;

  @EpochMs()
  public CreatedAt: number;

  @EpochMs()
  public StartedAt: number | null;

  @EpochMs()
  public FinishedAt: number | null;

  @EpochMs()
  public UpdatedAt: number | null;

  public Progress: number;

  public CurrentStep: string | null;

  public Message: string | null;

  @Json()
  public Checkpoint: unknown;

  @Json()
  public Result: unknown;

  @Json()
  public Error: StructuredError | null;

  public JobId: string | null;

  public LeaseOwner: string | null;

  @EpochMs()
  public LeaseUntil: number | null;

  @Bool()
  public CancelRequested: boolean;

  /** Runs without the schedule lease (forced manual run on overlap 'skip', or runOn 'all'). */
  @Bool()
  public Forced: boolean;

  @Json()
  public ResumeFrom: { runId: string; fromStep?: string } | null;

  /** Set once the journal dropped a progress row of this run (runLogLimit). */
  @Bool()
  public ProgressCapped: boolean;
}
