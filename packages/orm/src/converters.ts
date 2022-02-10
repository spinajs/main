import { ValueConverter } from './interfaces';

/**
 * UUid converter to & from db as binary
 */
export class UuidConverter extends ValueConverter {
  public toDB(value: string) {
    const buffer = Buffer.alloc(16);

    if (!value) {
      return null;
    }

    buffer.write(value.replace(/-/g, ''), 'hex');

    return buffer;
  }

  public fromDB(value: Buffer) {
    return value.toString('hex');
  }
}
