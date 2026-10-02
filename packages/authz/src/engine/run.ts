/**
 * One pipeline for async and sync callers: steps are generators that `yield`
 * values which may be promises and get the settled value back.
 */
export type Pipeline<T> = Generator<unknown, T, unknown>;

/** Yielded in sync mode when a step would need IO before it starts it. */
export const NEEDS_ASYNC: unique symbol = Symbol('authz.needsAsync');

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';
}

export async function runAsync<T>(pipeline: Pipeline<T>): Promise<T> {
  let step = pipeline.next();
  while (!step.done) {
    let value: unknown;
    let failure: { error: unknown } | undefined;
    try {
      if (step.value === NEEDS_ASYNC) throw new Error('authz engine: a sync-only step ran in async mode');
      value = await step.value;
    } catch (error) {
      failure = { error };
    }
    step = failure ? pipeline.throw(failure.error) : pipeline.next(value);
  }
  return step.value;
}

/** `undefined` when some step needs IO; the pipeline is then closed. */
export function runSync<T>(pipeline: Pipeline<T>): { readonly value: T } | undefined {
  let step = pipeline.next();
  while (!step.done) {
    let pending: boolean;
    try {
      pending = step.value === NEEDS_ASYNC || isThenable(step.value);
    } catch {
      pending = true;
    }
    if (pending) {
      if (step.value !== NEEDS_ASYNC) swallow(step.value);
      pipeline.return(undefined as T);
      return undefined;
    }
    step = pipeline.next(step.value);
  }
  return { value: step.value };
}

/** Keeps an abandoned promise from becoming an unhandled rejection. */
export function swallow(v: unknown): void {
  try {
    if (isThenable(v)) v.then(undefined, () => undefined);
  } catch {
    // a thenable whose then() throws has nothing left to reject
  }
}

export type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Never rejects; a result after `ms` is ignored and its rejection caught. */
export function settleWithin(p: PromiseLike<unknown>, ms: number, describe: (e: unknown) => string): Promise<Settled> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: Settled) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(s);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timed out after ${ms} ms` }), ms);
    try {
      p.then(
        (value) => finish({ ok: true, value }),
        (e) => finish({ ok: false, error: `evaluate rejected: ${describe(e)}` }),
      );
    } catch (e) {
      finish({ ok: false, error: `evaluate returned a broken thenable: ${describe(e)}` });
    }
  });
}
