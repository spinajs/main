export interface SessionHandle {
  /** Raw id; lives only in memory and the cookie. */
  readonly id: string;
  readonly state: 'pending' | 'active';
}
