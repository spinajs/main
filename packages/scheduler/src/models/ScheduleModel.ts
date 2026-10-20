import { Bool, Connection, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler')
export class ScheduleModel extends ModelBase {
  @Primary()
  public Name: string;

  @Json()
  public Definition: Record<string, unknown>;

  public DefinitionHash: string;

  @EpochMs()
  public NextRunAt: number | null;

  @EpochMs()
  public LastFiredAt: number | null;

  @EpochMs()
  public LastFinishedAt: number | null;

  public LastStatus: string | null;

  public LastRunId: string | null;

  @Bool()
  public Paused: boolean;

  public PausedReason: 'manual' | 'failures' | null;

  @Bool()
  public HardPaused: boolean;

  public ConsecutiveFailures: number;

  @EpochMs()
  public LastSuccessAt: number | null;

  public LeaseOwner: string | null;

  @EpochMs()
  public LeaseUntil: number | null;

  @Bool()
  public Orphaned: boolean;

  @EpochMs()
  public UpdatedAt: number;
}
