// Boots the installed app-basic from its own directory, in whichever manifest mode the environment selects, and prints
// what it serves plus which scan entry points ran. Plain node on the built packages: ts-node would load typescript itself.
import * as nodeModule from 'node:module';

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`<<JSON\n${JSON.stringify({ unsupported: `module.registerHooks is missing in Node ${process.version}; this probe needs Node >= 22.15` })}\nJSON>>`);
  process.exit(0);
}

const imports = [];
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(typescript|glob)(\/|$)/.test(specifier)) imports.push({ specifier, parent: context.parentURL ?? '' });
    return nextResolve(specifier, context);
  },
});

// an app's entry imports its packages before anything resolves, which registers the sources they ship
const { PrincipalMiddleware } = await import('@spinajs/authz-http');
const { DI, Bootstrapper } = await import('@spinajs/di');
const { Configuration, BaseFileSource } = await import('@spinajs/configuration');
const { BaseController, Controllers, HttpServer, ServerMiddleware, FilesystemControllerSource } = await import('@spinajs/http');
const { Orm, FilesystemMigrationSource } = await import('@spinajs/orm');
const { ScheduleRegistry } = await import('@spinajs/scheduler');
const { SocketHandlerRegistry, SocketServer } = await import('@spinajs/http-socket');
const { PROTOCOL_VERSION, WIRE_EVENTS } = await import('@spinajs/http-socket-common');
const { Cli } = await import('@spinajs/cli');
const { fsService } = await import('@spinajs/fs');
const { Intl } = await import('@spinajs/intl');
await import('@spinajs/orm-sqlite');
await import('@spinajs/log');
const glob = (await import('glob')).default;

const scans = { ancestorWalks: 0, controllerDirScans: 0, migrationDirScans: 0, globPatterns: [] };

const spy = (owner, name, onCall) => {
  const original = owner[name];
  owner[name] = function (...args) {
    onCall(args);
    return original.apply(this, args);
  };
};
spy(BaseFileSource, 'nodeModulesAncestors', () => scans.ancestorWalks++);
spy(glob, 'sync', ([pattern]) => scans.globPatterns.push(String(pattern).split('\\').join('/')));

// A source's getControllers() / getMigrations() also runs when there is nothing to scan; a scan is a call that globbed directories.
const countDirScans = (kind, type, method) => {
  const original = type.prototype[method];
  type.prototype[method] = async function (...args) {
    const start = scans.globPatterns.length;
    try {
      return await original.apply(this, args);
    } finally {
      if (scans.globPatterns.length > start) scans[kind]++;
    }
  };
};
countDirScans('controllerDirScans', FilesystemControllerSource, 'getControllers');
countDirScans('migrationDirScans', FilesystemMigrationSource, 'getMigrations');

/** Sends each `[command, payload]` of E2E_SOCKET_CALLS from a real client and returns what the booted server answers. */
async function socketReplies(base) {
  const calls = JSON.parse(process.env.E2E_SOCKET_CALLS ?? '[]');
  if (calls.length === 0) return [];

  const { io } = await import('socket.io-client');
  const socket = io(base, { path: '/socket.io', transports: ['websocket'], reconnection: false, forceNew: true, auth: { protocol: PROTOCOL_VERSION, clientId: 'probe' } });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const replies = [];
  for (const [index, [name, payload]] of calls.entries()) {
    replies.push(await socket.timeout(5000).emitWithAck(WIRE_EVENTS.command, { id: `probe-${index}`, name, payload }));
  }
  socket.close();
  return replies;
}

const result = { imports, scans };
try {
  // the middleware stops the server when no authz domain boots; which domain answers is not what this probe checks
  DI.unregister(ServerMiddleware, PrincipalMiddleware);
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Intl);
  const orm = await DI.resolve(Orm);
  await DI.resolve(Controllers);
  const server = await DI.resolve(HttpServer);
  await server.start();
  const base = `http://127.0.0.1:${server.Server.address().port}`;

  const get = async (path) => {
    const res = await fetch(base + path);
    const text = await res.text();
    return { status: res.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
  };
  result.responses = {
    health: await get('/health/get'),
    users: await get('/users/list?query=' + encodeURIComponent(JSON.stringify({ page: 1, perPage: 5 }))),
    // mounted by ExplainControllerSource only, and never in production
    explain: await get('/authz/explain'),
  };

  await DI.resolve(SocketServer);
  const sockets = await DI.resolve(SocketHandlerRegistry);
  await sockets.build();
  const cli = await DI.resolve(Cli);

  result.controllers = (DI.getRegisteredTypes(BaseController) ?? []).map((c) => c.name).sort();
  result.migrations = orm.Migrations.map((m) => m.type.name);
  result.schedules = (await DI.resolve(ScheduleRegistry)).all().map((s) => s.name).sort();
  result.commands = (await cli.Commands).map((c) => c.name).sort();
  result.socketCommands = [...sockets.Commands.keys()].sort();
  result.socketReplies = await socketReplies(base);
  await server.stop();
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message), stack: String(err?.stack) };
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
