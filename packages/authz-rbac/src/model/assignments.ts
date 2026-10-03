import { principalKey, resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject } from '@spinajs/authz';

// '%' never starts a principalKey unescaped, so a set key cannot equal a principal's.
export const subjectKey = (s: AssignmentSubject): string => ('set' in s ? `%set:${JSON.stringify([s.set.role, resourceKey(s.set.scope)])}` : principalKey(s));

export const isLive = (a: Assignment, at: Date): boolean => a.expiresAt == null || a.expiresAt.getTime() > at.getTime();
