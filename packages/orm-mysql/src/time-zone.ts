import { OrmException } from '@spinajs/orm';

/**
 * The zone a connection's datetimes live in, as each layer spells it. `Session` is what `SET time_zone` sends,
 * null when the server's own zone is kept; `Driver` is the mysql2 `timezone` option; `Wall` is the luxon zone of
 * the wall clock a DATETIME column holds.
 */
export interface IMySqlSessionZone {
  Session: string | null;
  Driver: string;
  Wall: string;
}

const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * Reads the `TimeZone` connection option.
 *
 * `SYSTEM` (the default) keeps the server's zone and reads and writes datetimes in the zone of the node process,
 * so the two must be the same zone. A named zone such as `Europe/Warsaw` is refused: mysql2 reads datetimes only
 * in the process zone, in UTC or at a fixed offset.
 *
 * @param option - the `TimeZone` value of the connection
 * @param connection - the connection name, for the error
 */
export function mySqlSessionZone(option: string | undefined, connection: string): IMySqlSessionZone {
  const value = (option ?? 'SYSTEM').trim();
  const upper = value.toUpperCase();

  if (upper === 'SYSTEM') {
    return { Session: null, Driver: 'local', Wall: 'system' };
  }

  if (upper === 'UTC' || upper === 'Z' || value === '+00:00') {
    return { Session: '+00:00', Driver: 'Z', Wall: 'utc' };
  }

  const offset = OFFSET.exec(value);
  if (offset && Number(offset[2]) <= 14 && Number(offset[3]) < 60) {
    return { Session: value, Driver: value, Wall: `UTC${value}` };
  }

  throw new OrmException(`connection ${connection}: TimeZone '${option}' is not 'SYSTEM', 'UTC' or an offset like '+02:00'`);
}
