/**
 * A source of the current time. An abstract class rather than an interface so a DI token
 * ( eg. `abstract class AppClock extends Clock` ) can extend it; any `{ now(): Date }` object fits structurally.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** The wall clock. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock that moves only when told to, for tests. */
export class ManualClock extends Clock {
  private ms: number;

  constructor(start: Date = new Date(0)) {
    super();
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): this {
    this.ms += ms;
    return this;
  }

  set(at: Date): this {
    this.ms = at.getTime();
    return this;
  }
}
