import { Exception } from '@spinajs/exceptions';

/** A replay was refused: `concurrency` replays of its domain run in this process already. */
export class ReplayBusy extends Exception {
  constructor(
    readonly domain: string,
    readonly concurrency: number,
  ) {
    super(`replay: ${concurrency} ${domain} replays are running in this process already (replay.domains.${domain}.concurrency, else replay.concurrency)`);
  }
}

/** Thrown by a `RecordingSource` for a stored recording it cannot read back; the replay answers it as unreplayable. */
export class RecordingUnreadable extends Exception {}
