import { QueueEvent, Event, IJobFailureContext } from '@spinajs/queue';
import { DateTime } from 'luxon';
import { IEmail, IEmailTemplate } from '../interfaces.js';

/**
 * Emitted when a deferred email job has finally failed ( retries exhausted ).
 * Carries only wire-safe fields so it can be routed to alerting / dead-letter handling.
 */
@Event()
export class EmailSendFailed extends QueueEvent {
  public Connection?: string;

  public From: string;

  public To: string[];

  public Subject: string;

  /**
   * Email template eg. pug file or mustashe
   */
  public Template?: string | IEmailTemplate;

  /**
   * Additional tag for email, usefull for identyfying emails by category or module that sends it
   */
  public Tag?: string;

  /**
   * Unique email id, for identification eg. in case of delivery failure
   */
  public EmailId?: string;

  /**
   * Id of the failed queue job.
   */
  public JobId?: string;

  /**
   * Failure reason - message only, so it stays wire-safe ( no stack / PII ).
   */
  public Error: string;

  /**
   * The attempt number that finally failed.
   */
  public Attempt?: number;

  /**
   * The dispatch-time retry limit for the job.
   */
  public MaxAttempts?: number;

  public FailedAt: DateTime;

  constructor(email: IEmail, err: unknown, ctx?: IJobFailureContext) {
    super();

    this.Connection = email.connection;
    this.From = email.from ?? '';
    this.To = email.to;
    this.Subject = email.subject;
    this.Template = email.template;
    this.Tag = email.tag;
    this.EmailId = email.emailId;

    this.JobId = ctx?.jobId;
    this.Attempt = ctx?.attempt;
    this.MaxAttempts = ctx?.maxAttempts;

    this.Error = err instanceof Error ? err.message : String(err);

    this.FailedAt = DateTime.now();
  }
}
