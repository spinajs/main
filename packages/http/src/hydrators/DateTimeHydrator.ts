import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';
import { IRouteParameter } from '../interfaces.js';
import { ArgHydrator } from '../route-args/ArgHydrator.js';
import _ from 'lodash';

@Injectable()
export class DateTimeHydrator extends ArgHydrator {
  public async hydrate(input: unknown, parameter: IRouteParameter): Promise<DateTime> {
    const result = parse(input);

    // An absent optional argument keeps reaching the action as before; only a value the client sent is refused.
    if (!result.isValid && input !== undefined && input !== null) {
      throw new BadRequest(`Argument '${parameter.Name}' is not a valid date`);
    }

    return result;
  }
}

function parse(input: unknown): DateTime {
  const secondsFromEpoch = Number(input);
  if (!Number.isNaN(secondsFromEpoch)) {
    return DateTime.fromSeconds(secondsFromEpoch);
  }

  if (_.isString(input)) {
    if (input.startsWith('Date:')) {
      // handle HTTP header date format
      return DateTime.fromHTTP(input.substring(5).trim());
    }

    return DateTime.fromISO(input.trim());
  }

  return DateTime.invalid('no iso or unix timestamp');
}
