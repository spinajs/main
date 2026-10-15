import { Bool, Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import type { RunStatus, RunTrigger, StructuredError, TriggeredBy } from '../contract.js';
import { EpochMs, JsonText } from './converters.js';

@Connection('default')
@Model('__scheduler_run')
export class RunModel extends ModelBase {
  @Primary()
  public Id: string;

  public Schedule: string;

  public Trigger: RunTrigger;

  @JsonText()
  public TriggeredBy: TriggeredBy | null;

  public ParentRunId: string | null;

  @JsonText()
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

  @JsonText()
  public Checkpoint: unknown;

  @JsonText()
  public Result: unknown;

  @JsonText()
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

  @JsonText()
  public ResumeFrom: { runId: string; fromStep?: string } | null;

  /** Set once the journal dropped a progress row of this run (runLogLimit). */
  @Bool()
  public ProgressCapped: boolean;
}
