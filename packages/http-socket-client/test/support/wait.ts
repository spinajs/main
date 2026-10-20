import type { ConnectionState } from '../../src/connection.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean, timeoutMs = 5000, stepMs = 5): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

/** Resolves with the arguments of the next emit. Subscribe before triggering the event. */
export function nextEmit<A extends unknown[]>(subscribe: (listener: (...args: A) => void) => () => void, timeoutMs = 5000): Promise<A> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no emit within ${timeoutMs} ms`));
    }, timeoutMs);
    unsubscribe = subscribe((...args) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(args);
    });
  });
}

export interface Stateful {
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState, previous: ConnectionState) => void): () => void;
}

export function waitForState(target: Stateful, wanted: ConnectionState, timeoutMs = 5000): Promise<void> {
  if (target.state === wanted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`state '${wanted}' not reached within ${timeoutMs} ms (still '${target.state}')`));
    }, timeoutMs);
    unsubscribe = target.onState((state) => {
      if (state !== wanted) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

export interface StateRecord {
  state: ConnectionState;
  at: number;
}

export function recordStates(target: Stateful): StateRecord[] {
  const records: StateRecord[] = [];
  target.onState((state) => records.push({ state, at: Date.now() }));
  return records;
}

/** Milliseconds from each 'offline' to the 'connecting' that follows it: the scheduled retry delays. */
export function retryGaps(records: StateRecord[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < records.length; i++) {
    if (records[i - 1].state === 'offline' && records[i].state === 'connecting') gaps.push(records[i].at - records[i - 1].at);
  }
  return gaps;
}
