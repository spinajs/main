/** The durable crash contract: an error with `crash: true` stands for a dead process, which writes and settles nothing. */
export function isCrash(error: unknown): error is { readonly crash: true } {
  return typeof error === 'object' && error !== null && 'crash' in error && error.crash === true;
}
