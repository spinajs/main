import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A32: AuthnRule = defineRule('A32', 'pending 2.x resets and invites survive the upgrade', []);
