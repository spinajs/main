import type { TargetName } from './case.js';

export interface ConformanceTarget {
  readonly name: TargetName;
  readonly connection: Readonly<Record<string, unknown>>;
}

const SERVERS: ReadonlyArray<{ name: TargetName; env: string; driver: string }> = [
  { name: 'postgres', env: 'ORM_CONFORMANCE_POSTGRES', driver: 'orm-driver-postgres' },
  { name: 'mysql', env: 'ORM_CONFORMANCE_MYSQL', driver: 'orm-driver-mysql' },
  { name: 'mssql', env: 'ORM_CONFORMANCE_MSSQL', driver: 'orm-driver-mssql' },
];

/** A connection entry from `scheme://user:password@host:port/database`. */
export function serverConnection(name: TargetName, driver: string, url: string): Record<string, unknown> {
  const parsed = new URL(url);
  const connection = {
    Driver: driver,
    Host: parsed.hostname,
    ...(parsed.port ? { Port: Number(parsed.port) } : {}),
    User: decodeURIComponent(parsed.username),
    Password: decodeURIComponent(parsed.password),
    Database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };

  // The compose and CI SQL Server containers serve a self-signed certificate.
  return name === 'mssql' ? { ...connection, Options: { TrustServerCertificate: true, Schema: 'dbo' } } : connection;
}

/** PGlite ( the reference ) and sqlite always; a server when its `ORM_CONFORMANCE_*` URL is set. */
export function availableTargets(env: NodeJS.ProcessEnv = process.env): ConformanceTarget[] {
  const targets: ConformanceTarget[] = [
    { name: 'pglite', connection: { Driver: 'orm-driver-pglite' } },
    { name: 'sqlite', connection: { Driver: 'orm-driver-sqlite', Filename: ':memory:' } },
  ];

  for (const server of SERVERS) {
    const url = env[server.env];
    if (url) {
      targets.push({ name: server.name, connection: serverConnection(server.name, server.driver, url) });
    }
  }

  return targets;
}
