import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

/** A response that does not verify: malformed, a used, expired or foreign challenge, a wrong origin or signature. */
export class WebAuthnInvalidResponse extends InvalidArgument {}

/** Recovery codes need a registered credential. */
export class WebAuthnNotEnrolled extends InvalidOperation {}
