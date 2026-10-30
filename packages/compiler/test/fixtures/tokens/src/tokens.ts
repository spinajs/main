import { token } from '@spinajs/di';
import { MANIFEST_TOKEN } from '@spinajs/manifest';

export interface Mailer {
  send(): void;
}

export const MAILER = token<Mailer>('__mailer__');
export const SETTINGS = token<{ retries: number }>('__settings__', 'mail settings');
export const MANIFEST_LIKE = token<object>(MANIFEST_TOKEN);
