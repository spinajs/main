import { randomUUID } from 'node:crypto';
import { IdentityLinkStore } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityLink, IdentityRef } from '@spinajs/authn/contracts';

export class MemoryLinkStore extends IdentityLinkStore {
  private all: IdentityLink[] = [];

  get links(): readonly IdentityLink[] {
    return [...this.all];
  }

  async find(provider: string, subject: string): Promise<IdentityLink | null> {
    return this.all.find((l) => l.provider === provider && l.subject === subject) ?? null;
  }

  async list(identity: IdentityRef): Promise<readonly IdentityLink[]> {
    return this.all.filter((l) => l.identity.type === identity.type && l.identity.id === identity.id);
  }

  async link(identity: IdentityRef, external: ExternalSubject): Promise<IdentityLink> {
    if (this.all.some((l) => l.provider === external.provider && l.subject === external.subject)) {
      throw new Error('duplicate (provider, subject)');
    }
    const link: IdentityLink = { id: randomUUID(), identity, provider: external.provider, subject: external.subject, ...(external.email !== undefined ? { email: external.email } : {}), linkedAt: new Date() };
    this.all.push(link);
    return link;
  }

  async unlink(id: string): Promise<void> {
    this.all = this.all.filter((l) => l.id !== id);
  }
}
