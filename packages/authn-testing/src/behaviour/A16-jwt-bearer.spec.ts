import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A16: AuthnRule = defineRule('A16', 'JWT bearers only from configured issuers and links', []);
