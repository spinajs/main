import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime, Settings } from 'luxon';

import { instantFromDb, toInstant } from '../src/converters.js';

const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);

function inZone<T>(zone: string, fn: () => T): T {
  const tz = process.env.TZ;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const luxonZone = Settings.defaultZone;
  process.env.TZ = zone;
  Settings.defaultZone = zone;
  try {
    return fn();
  } finally {
    // Deleting TZ alone keeps Node in the last zone; setting it back first resets it.
    process.env.TZ = tz ?? system;
    if (tz === undefined) delete process.env.TZ;
    Settings.defaultZone = luxonZone;
  }
}

describe('datetime instants', () => {
  describe('toInstant', () => {
    it('gives one UTC instant for a Date, a DateTime in any zone and ISO text with an offset, whatever the process zone', () => {
      for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC']) {
        inZone(zone, () => {
          for (const value of [new Date(AT), DateTime.fromMillis(AT), DateTime.fromMillis(AT).setZone('Pacific/Kiritimati'), '2026-10-19T17:30:00.123+05:30', '2026-10-19T12:00:00.123Z']) {
            const dt = toInstant(value)!;
            expect(dt.toMillis(), `${zone}: ${String(value)}`).to.eq(AT);
            expect(dt.zoneName, `${zone}: ${String(value)}`).to.eq('UTC');
          }
        });
      }
    });

    it('reads ISO and SQL text without an offset as UTC', () => {
      inZone('Asia/Kolkata', () => {
        expect(toInstant('2026-10-19T12:00:00.123')!.toMillis()).to.eq(AT);
        expect(toInstant('2026-10-19 12:00:00.123')!.toMillis()).to.eq(AT);
      });
    });

    it('reads a number as unix seconds', () => {
      expect(toInstant(1_000)!.toMillis()).to.eq(1_000_000);
    });

    it('keeps the epoch, unix seconds 0', () => {
      expect(toInstant(0)!.toMillis()).to.eq(0);
    });

    it('gives null for no value and for an invalid date', () => {
      for (const value of [null, undefined, '', new Date(NaN), DateTime.invalid('test')]) {
        expect(toInstant(value), String(value)).to.eq(null);
      }
    });

    it('refuses what is not a datetime, naming the column', () => {
      expect(() => toInstant('soon', 'expires_at')).to.throw(InvalidArgument, 'column expires_at: "soon" is not an ISO 8601 or SQL datetime');
      expect(() => toInstant({}, 'expires_at')).to.throw(InvalidArgument, 'column expires_at: a Object is not a datetime');
    });
  });

  describe('instantFromDb', () => {
    it('reads every driver form as a DateTime in UTC', () => {
      inZone('America/New_York', () => {
        for (const value of [new Date(AT), DateTime.fromMillis(AT), '2026-10-19T12:00:00.123Z', '2026-10-19 12:00:00.123', '2026-10-19 12:00:00.123+00']) {
          const dt = instantFromDb(value)!;
          expect(dt.toMillis(), String(value)).to.eq(AT);
          expect(dt.zoneName, String(value)).to.eq('UTC');
        }
        expect(instantFromDb(1_760_875_200)!.toMillis()).to.eq(1_760_875_200_000);
      });
    });

    it('keeps the epoch, unix seconds 0', () => {
      expect(instantFromDb(0)!.toMillis()).to.eq(0);
    });

    it('gives null for no value and for what does not parse as a datetime', () => {
      for (const value of [null, undefined, '', 'soon', new Date(NaN), DateTime.invalid('test')]) {
        expect(instantFromDb(value), String(value)).to.eq(null);
      }
    });
  });
});
