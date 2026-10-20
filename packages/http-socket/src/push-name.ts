import { InvalidArgument } from '@spinajs/exceptions';
import { MAX_NAME_LENGTH, NAME_PATTERN, isName } from '@spinajs/http-socket-common';

const SYSTEM_PREFIX = 'sys.';

/** Names of user-facing pushes; the `sys.` namespace is reserved for notices the server itself sends. */
export function assertPushName(name: unknown): asserts name is string {
  if (!isName(name)) {
    throw new InvalidArgument(`Pushed event name must match ${NAME_PATTERN} and be at most ${MAX_NAME_LENGTH} characters`);
  }

  if (name.startsWith(SYSTEM_PREFIX)) {
    throw new InvalidArgument(`Pushed event name must not start with the reserved '${SYSTEM_PREFIX}'`);
  }
}
