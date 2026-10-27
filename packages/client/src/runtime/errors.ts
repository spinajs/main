/** Structural copy of the `@spinajs/http` ProblemDetails; the browser-safe runtime must not depend on the server package. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: unknown;
}

export class ProblemError extends Error {
  constructor(
    public readonly problem: ProblemDetails,
    public readonly status: number,
  ) {
    super(`${status} ${problem.title}${problem.detail ? `: ${problem.detail}` : ''}`);
    this.name = 'ProblemError';
  }
}
