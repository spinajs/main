import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

export class AuditConfigError extends InvalidArgument {}
/** Thrown into the audited operation when a 'reject' write or a transactional write fails. */
export class AuditWriteFailed extends InvalidOperation {}
/** A read, an erasure or a verification the trail cannot answer from this application. */
export class AuditNotSupported extends InvalidOperation {}
