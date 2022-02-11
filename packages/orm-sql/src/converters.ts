import { IValueConverter } from '@spinajs/orm';

export class SqlSetConverter implements IValueConverter {
  public toDB(value: unknown[]) {
    if (value) {
      return value.join(',');
    }
    return '';
  }

  public fromDB(value: string) {
    if (value) {
      return value.split(',');
    }
    return [];
  }
}
