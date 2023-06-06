import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { IRouteParameter } from '../interfaces.js';
import { ArgHydrator } from '../route-args/ArgHydrator.js';
import _ from 'lodash';

@Injectable()
export class DateTimeHydrator extends ArgHydrator {
  public async hydrate(input: any, _parameter: IRouteParameter): Promise<any> {
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
}
