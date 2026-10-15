/* eslint-disable @typescript-eslint/no-explicit-any */
import { JsonValueConverter } from '@spinajs/orm';

/** node-postgres already parses json/jsonb; a string here is either a JSON string value or JSON text from a TEXT column. */
export class PostgresJsonValueConverter extends JsonValueConverter {
  public fromDB(value: any): any {
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}
