import type { ResourceRef } from '@spinajs/authz';

import { GROUP_TYPE, TEAM_TYPE } from './api.js';

export const teamRef = (id: string): ResourceRef => Object.freeze({ type: TEAM_TYPE, id });
export const groupRef = (id: string): ResourceRef => Object.freeze({ type: GROUP_TYPE, id });
