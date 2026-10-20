import { randomBytes } from 'crypto';
import { hostname } from 'os';

let replicaId: string | undefined;

export function defaultReplicaId(): string {
  replicaId ??= `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  return replicaId;
}
