/**
 * Conditional blocks — `${?var} ... ${/var}`.
 *
 * The block between the opening `${?var}` and the closing `${/var}` is rendered
 * only when `var` is "truthy" in the supplied vars (present, not null, not the
 * empty string). The condition is evaluated BEFORE the inner variables are
 * substituted, so an absent variable never leaks a half-rendered fragment.
 *
 * Run:
 *   npx ts-node examples/03-conditional-blocks.ts
 */
import { format } from '@spinajs/configuration-common';

const layout = '${message}${?error} | error: ${error:message}${/error}';

// error present -> the block (and its inner ${error:message}) is rendered
console.log(
  format(
    {
      message: 'request failed',
      error: { message: 'connection refused' },
    } as any,
    layout,
  ),
); // "request failed | error: connection refused"

// error missing/null/'' -> the whole block is dropped
console.log(format({ message: 'request ok' }, layout)); // "request ok"
console.log(format({ message: 'request ok', error: null } as any, layout)); // "request ok"

// Multiple independent blocks compose left-to-right.
console.log(
  format(
    {
      message: 'job done',
      user: 'john',
      error: { message: 'partial', code: 500 },
    } as any,
    '${message}${?user} user=${user}${/user}${?error} [${error:code}] ${error:message}${/error}',
  ),
); // "job done user=john [500] partial"
