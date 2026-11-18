import type express from 'express';

import type { Response } from '../interfaces.js';

export interface IAnsweredError {
  readonly error: unknown;
  readonly answer: Response;
}

const answered = new WeakMap<express.Response, IAnsweredError>();

// Tolerates a missing response, like markStage(): the route-builder helpers are also called with bare stubs.
export function markAnswered(res: express.Response | undefined, error: unknown, answer: Response): void {
  if (res) {
    answered.set(res, { error, answer });
  }
}

export function answeredError(res: express.Response): IAnsweredError | undefined {
  return answered.get(res);
}

export function forgetAnswered(res: express.Response): void {
  answered.delete(res);
}
