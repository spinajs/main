/**
 * format() basics — filling a layout string with custom vars + built-ins.
 *
 * Run:
 *   npx ts-node examples/01-format-basics.ts
 */
import { format } from '@spinajs/configuration-common';

// `${name}` is replaced from the custom vars object you pass in, falling back
// to the DI-registered built-in variables (date, time, env, ...) when missing.
const line = format(
  {
    message: 'user logged in',
    user: 'alice',
  },
  '${date} [${user}] ${message}',
);

// e.g. "24/06/2026 [alice] user logged in"
console.log(line);

// `${name:option}` passes the part after the colon to the variable.
//  - for built-ins it is the format/argument (e.g. a luxon format)
//  - for an object custom var it is a property lookup (`${error:message}`)
console.log(format(null, 'started at ${time:HH:mm} on ${date:yyyy-MM-dd}'));

// The special `message` field is itself formatted before being interpolated,
// so it may contain variables of its own.
console.log(
  format(
    {
      message: 'hello ${who}',
      who: 'world',
    } as any,
    '>> ${message}',
  ),
);

// Unknown variables collapse to an empty string instead of being left literal.
console.log(format({ message: 'x' }, 'a ${missing} b')); // "a  b"
