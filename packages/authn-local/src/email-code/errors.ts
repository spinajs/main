import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

/** The identity has no verified address to send codes to, so it cannot enrol. */
export class EmailCodeAddressUnverified extends InvalidOperation {}

/** The identity is enrolled in the email code step. */
export class EmailCodeAlreadyEnrolled extends InvalidOperation {}

/** The mail throttle refused another code for now. */
export class EmailCodeThrottled extends InvalidOperation {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

/** The code does not match the pending one, or it is spent, expired or voided. */
export class EmailCodeInvalid extends InvalidArgument {}
