import { Schema } from '@spinajs/validation';
import _ from 'lodash';
import { DateTime as lDateTime } from 'luxon';
import { Hydrator } from '../decorators';
import { ArgHydrator } from '../route-args/ArgHydrator';

export namespace DateTime {
  class DateFromUnixHydrator extends ArgHydrator {
    public async hydrate(input: any): Promise<any> {
      return lDateTime.fromSeconds(_.isString(input) ? Number(input) : input);
    }
  }

  class DateFromIsoHydrator extends ArgHydrator {
    public async hydrate(input: any): Promise<any> {
      return lDateTime.fromISO(input);
    }
  }

  class DateFromHttpHydrator extends ArgHydrator {
    public async hydrate(input: any): Promise<any> {
      return lDateTime.fromHTTP(input.startsWith('Date:') ? input.substring(5).trim() : input.trim());
    }
  }

  @Schema({
    type: 'number',
    minimum: 0,
    maximum: 2147483647,
  })
  @Hydrator(DateFromUnixHydrator)
  export class FromUnix extends lDateTime {}

  @Hydrator(DateFromHttpHydrator)
  export class FromHTTP extends lDateTime {}

  @Schema({
    type: 'string',
    format: 'iso-date-time',
  })
  @Hydrator(DateFromIsoHydrator)
  export class FromISO extends lDateTime {}
}
