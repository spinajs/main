import { DateTime } from 'luxon';
import { ModelBase, Connection, Model, Json, CreatedAt, DateTime as DT, Primary } from '@spinajs/orm';

/**
 * Stores messages that exhausted their retry policy. Kept in the queue database so failed
 * jobs survive process restarts and can be inspected or replayed via `QueueService.requeueDeadLetter`.
 */
@Connection('queue')
@Model('queue_dead_letter')
export class DeadLetterModel extends ModelBase {
  @Primary()
  public Id: number;

  /**
   * Original job id ( null for events ).
   */
  public JobId: string;

  /**
   * Message class name ( eg. job / event type ).
   */
  public Name: string;

  /**
   * Message type - JOB or EVENT.
   */
  public Type: string;

  /**
   * Connection the message was originally routed to.
   */
  public Connection: string;

  /**
   * Full serialized message payload - used to replay ( requeue ) the message.
   */
  @Json()
  public Payload: unknown;

  /**
   * Error message that caused the message to be dead-lettered.
   */
  public Error: string;

  /**
   * Number of retry attempts performed before giving up.
   */
  public RetryCount: number;

  @CreatedAt()
  public CreatedAt: DateTime;

  @DT()
  public FailedAt: DateTime;
}
