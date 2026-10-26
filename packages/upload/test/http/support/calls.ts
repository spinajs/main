import type { UploadAction } from '../../../src/http/index.js';

export interface HookCall {
  readonly hook: 'onCompleted' | 'onAborted';
  readonly id: string;
  readonly status: string;
  readonly project: string;
}

export interface AuthorizeCall {
  readonly action: UploadAction;
  readonly session: string | null;
}

/** What TestUploadController saw. A module of its own, so the test files and the scanned controller share one copy. */
export const Seen = {
  hooks: [] as HookCall[],
  authorized: [] as AuthorizeCall[],
  /** The errors GuardedUploadController's own handler saw, with what answeredAsServerError said of them. */
  guarded: [] as { name: string; server: boolean }[],
  /** onCompleted rejects while this is above zero, counting down. */
  failCompletions: 0,
  reset(): void {
    Seen.hooks.length = 0;
    Seen.authorized.length = 0;
    Seen.guarded.length = 0;
    Seen.failCompletions = 0;
  },
};
