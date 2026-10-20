import { resourceKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, ResourceRef } from '@spinajs/authz';

import { AssignmentStore, RoleStore } from '../contracts.js';
import type { LadderDef, RoleDef } from '../contracts.js';
import { expiryTime, isLive, subjectKey } from './assignments.js';

/** Role definitions held in memory; `set` replaces them and changes the version. */
export class MemoryRoleStore extends RoleStore {
  readonly name = 'memory';
  private roles: readonly RoleDef[];
  private ladders: readonly LadderDef[];
  private revision = 1;

  constructor(roles: readonly RoleDef[] = [], ladders: readonly LadderDef[] = []) {
    super();
    this.roles = [...roles];
    this.ladders = [...ladders];
  }

  set(roles: readonly RoleDef[], ladders: readonly LadderDef[] = []): void {
    this.roles = [...roles];
    this.ladders = [...ladders];
    this.revision++;
  }

  async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    return { roles: this.roles, ladders: this.ladders };
  }

  async version(): Promise<string> {
    return String(this.revision);
  }
}

/** Assignments held in memory, for tests and for hosts that run the model without a database. */
export class MemoryAssignmentStore extends AssignmentStore {
  readonly name = 'memory';
  private readonly rows = new Map<string, Assignment>();

  constructor(rows: readonly Assignment[] = []) {
    super();
    for (const row of rows) this.add(row);
  }

  add(row: Assignment): void {
    if (this.rows.has(row.id)) throw new Error(`MemoryAssignmentStore: assignment '${row.id}' exists`);
    this.rows.set(row.id, row);
  }

  remove(id: string): void {
    this.rows.delete(id);
  }

  all(): readonly Assignment[] {
    return [...this.rows.values()];
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    const keys = new Set(subjects.map(subjectKey));
    // A row with an unreadable expiresAt goes to the model, which refuses it, rather than vanishing here.
    return this.all().filter((a) => keys.has(subjectKey(a.subject)) && (isLive(a, at) || Number.isNaN(expiryTime(a))));
  }

  async holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    const key = resourceKey(scope);
    return this.all()
      .filter((a) => a.role === role && resourceKey(a.scope) === key && isLive(a, at))
      .map((a) => a.subject);
  }

  async byId(id: string): Promise<Assignment | null> {
    return this.rows.get(id) ?? null;
  }
}
