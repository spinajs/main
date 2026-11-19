import { _check_arg, _is_uuid, _trim } from '@spinajs/util';

/** Whether `whereUuid` accepts `id`; it throws otherwise, which would turn a malformed stamp into a retry. */
export function isUserUuid(id: string): boolean {
  try {
    _check_arg(_trim(), _is_uuid())(id, 'uuid');
    return true;
  } catch {
    return false;
  }
}
