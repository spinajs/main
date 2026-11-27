import type { TenantScope } from '../../src/index.js';

export interface ObservedRun {
  readonly command: string;
  readonly atStart: TenantScope | undefined;
  readonly afterAwait: TenantScope | undefined;
}

/** What the commands of `test/cli-commands` saw; reset by the test before each run. */
export const observed: { runs: ObservedRun[]; preAction: Array<TenantScope | undefined>; detached?: Promise<TenantScope | undefined> } = { runs: [], preAction: [] };
