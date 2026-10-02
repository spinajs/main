export interface ThrottleKey {
  readonly kind: 'ip' | 'account' | 'account-ip' | 'global' | (string & {});
  readonly value: string;
}
