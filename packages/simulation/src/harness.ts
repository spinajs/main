import { runInContext, type SimContext } from './context.js';
import { SimCrash } from './crash.js';
import type { MutableSimEnv } from './env.js';
import type { ResolvedSimulationOptions, SimActor, SimFailure, SimReport, SimSystem, SimTraceAction } from './simulate.js';

type Outcome = { kind: 'done' } | { kind: 'error'; error: unknown };

interface Flight {
  actor: SimActor;
  ctx: SimContext;
  settled: Promise<Outcome>;
}

interface ParkWait {
  parked: Promise<'parked'>;
  cancel(): void;
}

/** Ends a run: a broken invariant, a tick that threw, a stuck tick, or an error in background work. */
export class SimFailureError extends Error {
  constructor(
    public readonly invariant: string,
    public readonly reason: unknown,
  ) {
    super(`${invariant}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = 'SimFailureError';
  }
}

/** A zero-delay timer chain or a 0 ms park loop would otherwise spin one advance forever. */
const MAX_EVENTS_PER_ADVANCE = 10_000;

const settle = (work: Promise<void>): Promise<Outcome> =>
  work.then(
    () => ({ kind: 'done' as const }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );

/**
 * Runs one seed. Exactly one piece of replica code makes progress at a time: a tick, a resumed
 * parked tick, or the work a single timer started; the database is settled between two of them.
 */
export class Harness {
  protected step = 0;
  protected readonly flights = new Map<string, Flight>();
  protected readonly rejections: unknown[] = [];

  constructor(
    protected readonly env: MutableSimEnv,
    protected readonly o: ResolvedSimulationOptions,
    protected readonly report: SimReport,
  ) {
    // traced where the fault runtime raises it, so a crash that production code swallowed still shows up
    env.onCrash = (ctx) => this.trace(ctx.replica, 'crash');
  }

  /**
   * Collects unhandled rejections until the returned function is called. It must outlive shutdown:
   * `crashAll()` rejects parks nobody awaits, and without a listener plain node exits on them.
   */
  public trapRejections(): () => void {
    const onRejection = (reason: unknown) => {
      if (!(reason instanceof SimCrash)) this.rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    return () => process.off('unhandledRejection', onRejection);
  }

  public async run(system: SimSystem): Promise<void> {
    for (this.step = 0; this.step < this.o.steps; this.step++) {
      await this.guarded('workload', () => system.workload(this.env.random, this.step));
      await this.env.settle();
      await this.turn(system);
      await this.advance(this.env.random.int(this.o.maxClockStepMs + 1));
      this.report.steps = this.step + 1;
      if (this.report.steps % this.o.checkEvery === 0) await this.check(system, false);
    }
    await this.quiesce(system);
    await this.check(system, true);
  }

  public failureOf(error: unknown): SimFailure {
    const failure = error instanceof SimFailureError ? error : new SimFailureError('build', error);
    return {
      invariant: failure.invariant,
      error: failure.reason,
      step: this.report.steps,
      replay: `npm run sim -- --suite ${this.o.suite} --seed ${this.o.seed}`,
    };
  }

  /** Kills every incarnation first, so parked and dead work unwinds instead of holding up dispose. */
  public async shutdown(system: SimSystem | undefined): Promise<void> {
    this.env.replicas.crashAll();
    try {
      // node reports the rejected parks only once the microtask queue drains
      await this.env.settle();
    } catch (error) {
      this.report.failure ??= this.failureOf(error);
    }
    try {
      await system?.dispose();
    } catch (error) {
      this.report.failure ??= this.failureOf(new SimFailureError('dispose', error));
    } finally {
      this.report.databaseFile = await this.env.shutdown(this.report.failure !== undefined);
    }
  }

  /** Picks a live actor, maybe pauses a replica, then runs the actor's tick (or restarts it). */
  protected async turn(system: SimSystem): Promise<void> {
    const { random, replicas, clock } = this.env;
    this.dropDeadFlights();
    const candidates =system.actors.filter((a) => !this.flights.has(a.replica) && !replicas.isFrozen(a.replica));
    if (candidates.length === 0) return this.trace('-', 'idle');
    const actor = random.pick(candidates);
    if (this.o.pausableReplicas.length > 0 && random.chance(this.o.pauseProbability)) {
      const target = random.pick(this.o.pausableReplicas);
      if (!replicas.isCrashed(target) && !this.flights.has(target)) {
        replicas.freeze(target, clock.now() + 1 + random.int(this.o.maxPauseMs));
        this.trace(target, 'pause');
      }
    }
    if (replicas.isCrashed(actor.replica)) {
      if (random.chance(this.o.restartProbability)) return this.restart(actor);
      return this.trace(actor.name, 'down');
    }
    if (replicas.isFrozen(actor.replica)) return this.trace(actor.name, 'frozen');
    return this.tick(actor);
  }

  protected tick(actor: SimActor): Promise<void> {
    this.trace(actor.name, 'tick');
    return this.follow(actor, this.env.replicas.context(actor.replica), () => actor.tick());
  }

  protected restart(actor: SimActor): Promise<void> {
    const ctx = this.env.replicas.restart(actor.replica);
    this.trace(actor.name, 'restart');
    return this.follow(actor, ctx, () => actor.restart());
  }

  protected follow(actor: SimActor, ctx: SimContext, work: () => Promise<void>): Promise<void> {
    const wait = this.env.replicas.whenParked(actor.replica);
    const settled = settle(runInContext(ctx, () => new Promise<void>((resolve) => resolve(work()))));
    return this.await({ actor, ctx, settled }, wait);
  }

  /** Waits until the flight settles or parks. A parked flight is awaited again when its replica thaws. */
  protected async await(flight: Flight, wait: ParkWait): Promise<void> {
    const { actor, ctx } = flight;
    let timer: NodeJS.Timeout | undefined;
    const stuck = new Promise<'stuck'>((resolve) => (timer = setTimeout(() => resolve('stuck'), this.o.tickTimeoutMs)));
    const first = await Promise.race([flight.settled, wait.parked, stuck]);
    clearTimeout(timer);
    wait.cancel();
    if (first === 'stuck') {
      throw new SimFailureError(`stuck:${actor.name}`, new Error(`${actor.name} did not settle within ${this.o.tickTimeoutMs} ms of real time; a tick must not wait on simulated time`));
    }
    if (first === 'parked') {
      this.flights.set(actor.replica, flight);
      // what the flight started before it parked must finish before any other replica code runs
      await this.env.settle();
      this.assertHealthy();
      return this.trace(actor.name, 'park');
    }
    this.flights.delete(actor.replica);
    // every SimCrash follows a FaultRuntime.crash, which traced it; an error from a live incarnation is a failure
    if (first.kind === 'error' && !this.env.replicas.isDead(ctx)) throw new SimFailureError(`tick:${actor.name}`, first.error);
    await this.env.settle();
    this.assertHealthy();
  }

  /** Moves simulated time to `now + ms` one event at a time: a thaw, or a single timer. */
  protected async advance(ms: number): Promise<void> {
    const { clock, replicas } = this.env;
    const target = clock.now() + ms;
    let events = 0;
    for (;;) {
      if (events > MAX_EVENTS_PER_ADVANCE) {
        throw new SimFailureError('stuck:clock', new Error(`more than ${MAX_EVENTS_PER_ADVANCE} timers or thaws within ${ms} ms of simulated time`));
      }
      const thawing = replicas.due(clock.now());
      if (thawing.length > 0) {
        events += thawing.length;
        for (const replica of thawing) await this.resume(replica);
        continue;
      }
      const timerAt = clock.nextDue(target);
      const thawAt = replicas.nextThaw(target);
      if (thawAt !== null && (timerAt === null || thawAt <= timerAt)) {
        clock.jump(thawAt - clock.now());
        continue;
      }
      if (timerAt === null) break;
      events++;
      clock.fireNext(target);
      await this.env.settle();
      this.assertHealthy();
    }
    clock.jump(target - clock.now());
  }

  protected async resume(replica: string): Promise<void> {
    const wait = this.env.replicas.whenParked(replica);
    this.env.replicas.thaw(replica);
    this.trace(replica, 'resume');
    const flight = this.flights.get(replica);
    if (flight) return this.await(flight, wait);
    wait.cancel();
    await this.env.settle();
    this.assertHealthy();
  }

  /** Faults off, every freeze over, every crashed actor restarted, then round-robin ticks until quiet. */
  protected async quiesce(system: SimSystem): Promise<void> {
    const { faults, replicas, clock } = this.env;
    this.env.quiescing = true;
    faults.enabled = false;
    const latest = replicas.latestFreeze();
    if (latest !== null) await this.advance(Math.max(0, latest - clock.now()));
    this.dropDeadFlights();
    for (const actor of system.actors) if (replicas.isCrashed(actor.replica)) await this.restart(actor);
    for (let round = 0; round < this.o.quiesceRounds; round++) {
      for (const actor of system.actors) {
        if (!this.flights.has(actor.replica) && !replicas.isFrozen(actor.replica)) await this.tick(actor);
      }
      await this.advance(this.o.maxClockStepMs);
      if (await this.guarded('quiesced', async () => (await system.quiesced?.()) ?? false)) return;
    }
  }

  protected async check(system: SimSystem, final: boolean): Promise<void> {
    await this.env.settle();
    for (const inv of system.invariants) {
      if (!inv.final || final) await this.guarded(inv.name, () => inv.check());
    }
  }

  /** Runs suite code and names the failure after `label`, unless it already is a SimFailureError. */
  protected async guarded<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof SimFailureError ? error : new SimFailureError(label, error);
    }
  }

  /**
   * A crash that lands on a parked replica from outside its flight (background work of the same
   * incarnation) unfreezes it, so no thaw ever resumes the flight and it would block the actor forever.
   */
  protected dropDeadFlights(): void {
    for (const [replica, flight] of this.flights) if (this.env.replicas.isDead(flight.ctx)) this.flights.delete(replica);
  }

  protected assertHealthy(): void {
    const errors = [...this.env.clock.takeFailures(), ...this.rejections.splice(0)].filter((e) => !(e instanceof SimCrash));
    if (errors.length > 0) throw new SimFailureError('background-error', errors[0]);
  }

  protected trace(actor: string, action: SimTraceAction): void {
    this.report.trace.push({ step: this.step, at: this.env.clock.now(), actor, action });
  }
}
