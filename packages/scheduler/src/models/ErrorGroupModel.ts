import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import type { ErrorGroupStatus } from '../contract.js';
import { EpochMs } from './converters.js';

@Connection('default')
@Model('__scheduler_error')
export class ErrorGroupModel extends ModelBase {
  @Primary()
  public Id: number;

  public Schedule: string;

  public Fingerprint: string;

  public Name: string;

  public SampleMessage: string;

  public SampleStack: string | null;

  public Count: number;

  @EpochMs()
  public FirstSeen: number;

  @EpochMs()
  public LastSeen: number;

  public LastRunId: string | null;

  public Status: ErrorGroupStatus;
}
