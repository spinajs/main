import { Ok } from '@spinajs/http';
import type { Response } from '@spinajs/http';
import { subjectLabel } from '@spinajs/teams';
import type { MemberEntry, Paged } from '@spinajs/teams';

export { NO_STORE } from '@spinajs/http';

export function done(): Response {
  return new Ok({ ok: true });
}

export interface MemberJson {
  readonly subject: string;
  readonly role: string;
  readonly assignmentId: string;
  readonly expiresAt: Date | null;
}

export function memberJson(m: MemberEntry): MemberJson {
  return Object.freeze({ subject: subjectLabel(m.subject), role: m.role, assignmentId: m.assignmentId, expiresAt: m.expiresAt });
}

export function membersJson(page: Paged<MemberEntry>): { readonly items: readonly MemberJson[]; readonly total: number } {
  return Object.freeze({ items: Object.freeze(page.items.map(memberJson)), total: page.total });
}
