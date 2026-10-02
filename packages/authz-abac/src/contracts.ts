import type { Policy } from '@spinajs/authz';

// Declared in the core because AuthzCommand carries it.
export type { Policy } from '@spinajs/authz';

export abstract class PolicyStore {
  abstract readonly name: string;
  abstract load(): Promise<readonly Policy[]>;
  abstract version(): Promise<string>;
}
