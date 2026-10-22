import type { ListKind } from './contracts.js';

export interface TtlPair {
  positive: number;
  negative: number;
}

export interface ListSourceOptions {
  name: string;
  url: string;
  kind: ListKind;
  format: 'lines' | 'json';
}

export interface ListsOptions {
  refreshSeconds: number;
  minKeepRatio: number;
  sources: ListSourceOptions[];
}

export interface DnsOptions {
  servers: string[];
  timeoutMs: number;
  tries: number;
  ttl: TtlPair;
}

export interface RdapOptions {
  bootstrapUrl: string;
  requestTimeoutMs: number;
  minAgeDays: number;
  maxLookups: number;
  rateLimitedTtlSeconds: number;
  ttl: TtlPair;
}

export interface HttpProviderOptions {
  name: string;
  url: string;
  headers: Record<string, string>;
  resultPath: string;
  refuseWhen: Array<boolean | string | number>;
  reason: string;
  ttlSeconds: number;
}

export interface OrmStoreOptions {
  connection: string;
  cleanupIntervalMs: number;
}

export interface DynamoDbStoreOptions {
  table: string;
  config: Record<string, unknown>;
  createTable: boolean;
}

export interface EmailVerificationOptions {
  enabled: boolean;
  store: string;
  verifiers: Array<{ service: string }>;
  timeoutMs: number;
  onError: 'allow' | 'refuse';
  refuseCode: string;
  lru: { maxEntries: number; ttlSeconds: number };
  lists: ListsOptions;
  dns: DnsOptions;
  rdap: RdapOptions;
  http: { providers: HttpProviderOptions[] };
  orm: OrmStoreOptions;
  redis: Record<string, unknown>;
  dynamodb: DynamoDbStoreOptions;
}
