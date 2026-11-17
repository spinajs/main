import { CodedHttpException } from '@spinajs/exceptions';

/**
 * The answer to a request whose tenant is unknown, not active, closed to the principal, or not named at all. The
 * body is the same in every case, so it does not tell which tenants exist; the reason is `inner`, for the log.
 */
export class TenantRefused extends CodedHttpException<'tenant.unavailable'> {
  constructor(status: 403 | 404, reason: unknown) {
    super(status, 'tenant.unavailable', status === 404 ? 'Not found' : 'Forbidden', undefined, reason);
  }
}
