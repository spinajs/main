import { CredentialChangeBus } from '../contracts/credential-bus.js';
import type { CredentialChange } from '../contracts/credential-bus.js';

export class InProcessCredentialChangeBus extends CredentialChangeBus {
  public publish(_change: CredentialChange): Promise<void> {
    throw new Error('not implemented: InProcessCredentialChangeBus.publish');
  }

  public subscribe(_listener: (change: CredentialChange) => void): () => void {
    throw new Error('not implemented: InProcessCredentialChangeBus.subscribe');
  }
}
