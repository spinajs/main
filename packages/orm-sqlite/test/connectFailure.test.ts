/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { join } from 'path';
import { tmpdir } from 'os';
import { SqliteOrmDriver } from './../src/index.js';

chai.use(chaiAsPromised);

/**
 * A connection that cannot be opened must FAIL, not hang.
 *
 * `connect()` used to call `close()` on the handle sqlite3 had just failed to open, in order to
 * clean it up. node-sqlite3 never invokes the close callback for a database that never opened,
 * so the enclosing promise never settled and `connect()` waited forever — no error, no rejection,
 * no timeout. Any app pointed at a bad path, an unreadable file or a deleted directory hung at
 * startup instead of reporting SQLITE_CANTOPEN.
 *
 * The timeouts here are the assertion: they are far below any sane connect time, so a
 * regression re-introduces a hang and fails rather than passing slowly.
 */
describe('SqliteOrmDriver connect failure', function () {
  this.timeout(5000);

  function driverFor(filename: string) {
    return new SqliteOrmDriver({
      Driver: 'orm-driver-sqlite',
      Name: 'broken',
      Filename: filename,
    } as any);
  }

  it('rejects instead of hanging when the directory does not exist', async () => {
    const driver = driverFor(join(tmpdir(), 'spinajs-definitely-not-here-9f3a', 'db.sqlite'));

    await expect(driver.connect()).to.be.rejectedWith(/SQLITE_CANTOPEN|unable to open/i);
  });

  it('reports the failure quickly rather than waiting on a callback that never comes', async () => {
    const driver = driverFor(join(tmpdir(), 'spinajs-definitely-not-here-9f3a', 'db.sqlite'));

    const started = Date.now();
    await expect(driver.connect()).to.be.rejected;

    expect(Date.now() - started).to.be.lessThan(2000);
  });

  it('leaves no database handle behind after a failed connect', async () => {
    const driver = driverFor(join(tmpdir(), 'spinajs-definitely-not-here-9f3a', 'db.sqlite'));

    await expect(driver.connect()).to.be.rejected;

    // A half-open handle would be used by the next query and fail in a much stranger place.
    expect((driver as any).Db).to.satisfy((d: unknown) => d === null || d === undefined);
  });
});
