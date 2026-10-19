import { _check_arg, _is_string, _non_empty, _reg_match } from '@spinajs/util';

// Internal: the barrel does not export this module.

/** A non-empty filesystem name without ':' (the first ':' of a ref id ends the name). */
export function checkFsName(fsName: unknown): string {
  return _check_arg(_is_string(_non_empty(), _reg_match(/^[^:]*$/)))(fsName, 'fsName');
}

/** `value` as JSON for an error message; a value JSON cannot hold gives its String or its tag. */
export function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
