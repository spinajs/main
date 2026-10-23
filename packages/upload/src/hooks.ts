import type { UploadStateView } from './types.js';

/** Input of the 'upload.create' action; a before hook may refuse it (quotas) or replace `metadata`. */
export interface UploadCreateHookInput {
  name: string;
  size: number;
  sha256: string | null;
  partSize: number;
  partCount: number;
  declaredMime: string | null;
  owner: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Input of the 'upload.complete' action, which runs once per completed session while handled_at is null. An error in
 * an after hook is only logged (hooks/src/runner.ts:286-296); work that must be retried goes in a before hook.
 */
export interface UploadCompleteHookInput {
  readonly upload: UploadStateView;
  readonly owner: string | null;
  readonly metadata: Record<string, unknown>;
  readonly filesFs: string;
  readonly fileKey: string;
}

declare module '@spinajs/hooks' {
  interface HookActions {
    'upload.create': { input: UploadCreateHookInput; output: UploadStateView };
    'upload.complete': { input: UploadCompleteHookInput; output: unknown };
  }
}
