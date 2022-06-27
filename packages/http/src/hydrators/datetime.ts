import { Schema } from '@spinajs/validation';
import { DateTime as lDateTime } from 'luxon';
import { Hydrator } from '../decorators';
import { ArgHydrator } from '../route-args/ArgHydrator';

export namespace DateTime {
  class DateFromUnixHydrator extends ArgHydrator {
    public async hydrate(input: any): Promise<any> {
      return lDateTime.fromSeconds(input);
    }
  }

  class DateFromHTTPHydrator extends ArgHydrator {
    public async hydrate(input: any): Promise<any> {
      return lDateTime.fromHTTP(input);
    }
  }

  @Schema({
    type: 'number',
    minimum: 0,
    maximum: 2147483647,
  })
  @Hydrator(DateFromUnixHydrator)
  export class FromUnix extends lDateTime {}

  @Hydrator(DateFromHTTPHydrator)
  export class FromHTTP extends lDateTime {}

  @Schema({
    type: 'string',
    format: 'iso-date-time',
  })
  @Hydrator(DateFromHTTPHydrator)
  export class FromISO extends lDateTime {}
}
