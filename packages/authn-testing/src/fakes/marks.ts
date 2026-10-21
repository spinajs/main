import { MfaEnrolmentMarks } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

const keyOf = (id: IdentityRef, step: string) => `${id.type}:${id.id}:${step}`;

export class MemoryMfaEnrolmentMarks extends MfaEnrolmentMarks {
  private readonly marked = new Set<string>();

  async has(id: IdentityRef, step: string): Promise<boolean> {
    return this.marked.has(keyOf(id, step));
  }

  async mark(id: IdentityRef, step: string): Promise<boolean> {
    const key = keyOf(id, step);
    if (this.marked.has(key)) {
      return false;
    }
    this.marked.add(key);
    return true;
  }

  async unmark(id: IdentityRef, step: string): Promise<void> {
    this.marked.delete(keyOf(id, step));
  }
}
