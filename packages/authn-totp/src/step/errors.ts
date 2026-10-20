import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

/** The identity has a confirmed TOTP enrolment; a refused begin, or a confirmation that came too late. */
export class TotpAlreadyEnrolled extends InvalidOperation {}

/** The enrolment is confirmed, but its recovery codes could not be stored; the owner regenerates them. */
export class TotpRecoveryCodesNotIssued extends TotpAlreadyEnrolled {}

/** No pending enrolment to confirm. */
export class TotpNotBegun extends InvalidOperation {}

/** A begin replaced the secret the confirming code was checked against. */
export class TotpEnrolmentChanged extends InvalidOperation {}

/** Recovery codes need a confirmed enrolment. */
export class TotpNotEnrolled extends InvalidOperation {}

/** The code does not match the pending secret, or its time step is spent. */
export class TotpInvalidCode extends InvalidArgument {}
