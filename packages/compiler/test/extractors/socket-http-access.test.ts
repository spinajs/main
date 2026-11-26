import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ControllerEntry, ManifestFragment, SocketControllerEntry } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';
import { routeWithoutPolicy, socketWithoutPolicy } from '../../src/doctor/rules/index.js';
import { fixture } from '../doctor/fixture.js';

const write = (root: string, file: string, content: string): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2021', module: 'node16', moduleResolution: 'node16', experimentalDecorators: true, strict: true, noEmit: true, skipLibCheck: true, types: [], outDir: 'lib', rootDir: 'src' },
  include: ['src/*.ts'],
});

const DECORATORS = `declare function SocketController(prefix?: string): ClassDecorator;
declare function Command(name?: string): MethodDecorator;
declare function Get(path?: string): MethodDecorator;
declare function Access(permission: string): ClassDecorator & MethodDecorator;
declare function Policy(policy: unknown): ClassDecorator & MethodDecorator;
declare function SocketAccess(permission: string, options?: { allowAnonymous?: boolean }): ClassDecorator & MethodDecorator;
declare function SocketPolicy(policy: unknown): ClassDecorator & MethodDecorator;
`;

const SOCKETS = `import { BaseSocketController } from '@spinajs/http-socket';
${DECORATORS}
export class OpenPolicy {}
export class LockPolicy {}
export class GuardPolicy {}
export class ClassPolicy {}
export class SavePolicy {}
export class BasePolicy {}

@SocketController('mixed')
export class MixedSocket {
  @Command('open')
  @Access('open:http')
  public open(): void {}

  @Command('lock')
  @Policy(LockPolicy)
  public lock(): void {}

  @Command('close')
  @SocketAccess('close:socket')
  public close(): void {}

  @Command('guard')
  @SocketPolicy(GuardPolicy)
  public guard(): void {}
}

@SocketController('class-access')
@Access('class:http')
export class ClassHttpAccessSocket {
  @Command('ping')
  public ping(): void {}
}

@SocketController('class-policy')
@Policy(ClassPolicy)
export class ClassHttpPolicySocket {
  @Command('ping')
  public ping(): void {}
}

@SocketController('class-socket-policy')
@SocketPolicy(ClassPolicy)
export class ClassSocketPolicySocket {
  @Command('ping')
  public ping(): void {}
}

@Policy(BasePolicy)
export abstract class GuardedBase extends BaseSocketController {
  @Command('save')
  @SocketPolicy(SavePolicy)
  public save(): void {}

  @Command('peek')
  @Access('base:http')
  public peek(): void {}
}

@SocketController('local')
export class LocalSocket extends GuardedBase {}

@SocketController('gap')
export class GapSocket {
  @Command('peek')
  @Access('gap:http')
  @SocketAccess('gap:socket', { allowAnonymous: true })
  public peek(): void {}
}
`;

const ROUTES = `import { OpenPolicy } from './sockets.js';
${DECORATORS}
export class MixedRoutes {
  @Get('socket-policy')
  @SocketPolicy(OpenPolicy)
  public socketPolicy(): void {}

  @Get('policy')
  @Policy(OpenPolicy)
  public policy(): void {}

  @Get('access')
  @Access('route:http')
  public access(): void {}
}

@SocketPolicy(OpenPolicy)
export class ClassSocketPolicyRoutes {
  @Get('x')
  public x(): void {}
}
`;

const doctorCtx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const app = { name: 'guards-lib', version: '1.0.0', root: '/fixture', outDir: 'lib' };

describe('a guard decorator of the other transport', function () {
  this.timeout(300_000);
  let root: string;
  let lib: ManifestFragment;
  let dependent: ManifestFragment;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'socket-http-access-'));
    write(root, 'node_modules/@spinajs/http-socket/package.json', JSON.stringify({ name: '@spinajs/http-socket', version: '1.0.0', type: 'module', types: 'index.d.ts' }));
    write(root, 'node_modules/@spinajs/http-socket/index.d.ts', 'export declare abstract class BaseSocketController {}\n');

    write(root, 'lib-src/package.json', JSON.stringify({ name: 'guards-lib', version: '1.0.0', type: 'module', main: 'lib/sockets.js' }));
    write(root, 'lib-src/tsconfig.json', TSCONFIG);
    write(root, 'lib-src/src/sockets.ts', SOCKETS);
    write(root, 'lib-src/src/routes.ts', ROUTES);
    lib = await analyzePackage({ tsconfig: join(root, 'lib-src/tsconfig.json'), packageRoot: join(root, 'lib-src') });

    // The dependency as an app installs it: declarations without decorators, and the fragment its own build wrote.
    const installed = 'node_modules/guards-lib';
    write(root, `${installed}/package.json`, JSON.stringify({ name: 'guards-lib', version: '1.0.0', type: 'module', types: 'lib/sockets.d.ts', spinajs: { manifest: 'lib/manifest.fragment.json' } }));
    write(root, `${installed}/lib/sockets.d.ts`, "import { BaseSocketController } from '@spinajs/http-socket';\nexport declare abstract class GuardedBase extends BaseSocketController {\n    save(): void;\n    peek(): void;\n}\n");
    write(root, `${installed}/lib/manifest.fragment.json`, JSON.stringify(lib));

    write(root, 'app/package.json', JSON.stringify({ name: 'guards-app', version: '1.0.0', type: 'module', main: 'lib/app.js' }));
    write(root, 'app/tsconfig.json', TSCONFIG);
    write(root, 'app/src/app.ts', "import { GuardedBase } from 'guards-lib';\ndeclare function SocketController(prefix?: string): ClassDecorator;\n\n@SocketController('app')\nexport class AppSocket extends GuardedBase {}\n");
    dependent = await analyzePackage({ tsconfig: join(root, 'app/tsconfig.json'), packageRoot: join(root, 'app') });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const socket = (fragment: ManifestFragment, className: string): SocketControllerEntry => fragment.socketControllers.find((c) => c.className === className)!;
  const command = (fragment: ManifestFragment, className: string, name: string) => socket(fragment, className).commands.find((c) => c.name === name)!;
  const controller = (className: string): ControllerEntry => lib.controllers.find((c) => c.className === className)!;
  const route = (className: string, handler: string) => controller(className).routes.find((r) => r.handler === handler)!;
  const entryPoint = (fragment: ManifestFragment, id: string) => fragment.authz?.entryPoints.find((e) => e.id === id);
  const lineAt = (line: number): string => SOCKETS.split('\n')[line - 1].trim();

  describe('on a socket controller or handler', () => {
    it('records no guard for @Access or @Policy: @spinajs/http-socket mounts neither', () => {
      expect(command(lib, 'MixedSocket', 'open').policies).to.deep.equal([]);
      expect(command(lib, 'MixedSocket', 'lock').policies).to.deep.equal([]);
      expect(socket(lib, 'ClassHttpAccessSocket').policies).to.equal(undefined);
      expect(socket(lib, 'ClassHttpPolicySocket').policies).to.equal(undefined);
    });

    it('keeps @SocketAccess and @SocketPolicy as guards, on a handler and on a class', () => {
      expect(command(lib, 'MixedSocket', 'close').policies).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['handler'] }]]);
      expect(command(lib, 'MixedSocket', 'guard').policies).to.deep.equal([[{ type: 'GuardPolicy', options: [] }]]);
      expect(socket(lib, 'ClassSocketPolicySocket').policies).to.deep.equal([[{ type: 'ClassPolicy', options: [] }]]);
    });

    it('warns AUTHZ013 once at each such decorator, naming the socket form', () => {
      const warned = lib.diagnostics.filter((d) => d.code === 'AUTHZ013').map((d) => `${d.severity} ${lineAt(d.source!.line)}: ${d.message}`);
      const access = 'guards no socket handler: @spinajs/http-socket mounts @SocketAccess, so this check never runs here';
      const policy = 'guards no socket handler: @spinajs/http-socket mounts @SocketPolicy, so this check never runs here';
      expect(warned).to.have.members([
        `warning @Access('open:http'): @Access ${access}`,
        `warning @Policy(LockPolicy): @Policy ${policy}`,
        `warning @Access('class:http'): @Access ${access}`,
        `warning @Policy(ClassPolicy): @Policy ${policy}`,
        `warning @Policy(BasePolicy): @Policy ${policy}`,
        `warning @Access('base:http'): @Access ${access}`,
        `warning @Access('gap:http'): @Access ${access}`,
      ]);
      expect(warned).to.have.length(7);
    });

    it('leaves a handler guarded only by them without access, so the doctor reports it (AUTHZ003)', () => {
      const found = socketWithoutPolicy.run(fixture({ app, authz: lib.authz }), doctorCtx).map((d) => d.message.split(' has no')[0]);
      expect(found).to.have.members(['socket command mixed.open', 'socket command mixed.lock', 'socket command class-access.ping', 'socket command class-policy.ping', 'socket command local.peek']);
    });
  });

  describe('inherited from a base class', () => {
    it('of the same package: the base handler guard stays, the base http guards do not', () => {
      expect(socket(lib, 'LocalSocket').policies).to.equal(undefined);
      expect(command(lib, 'LocalSocket', 'save').policies).to.deep.equal([[{ type: 'SavePolicy', options: [] }]]);
      expect(command(lib, 'LocalSocket', 'peek').policies).to.deep.equal([]);
    });

    it('of a dependency, through the fragment its build wrote', () => {
      expect(socket(dependent, 'AppSocket').policies).to.equal(undefined);
      expect(command(dependent, 'AppSocket', 'save').policies).to.deep.equal([[{ type: 'SavePolicy', options: [] }]]);
      expect(command(dependent, 'AppSocket', 'peek').policies).to.deep.equal([]);
      expect(entryPoint(dependent, 'app.save')?.access).to.deep.equal([[{ type: 'SavePolicy', options: [] }]]);
      expect(entryPoint(dependent, 'app.peek')?.access).to.deep.equal([]);
    });
  });

  describe('@SocketPolicy on an http route or controller', () => {
    it('records no guard for it: @spinajs/http never mounts it', () => {
      expect(route('MixedRoutes', 'socketPolicy').policies).to.deep.equal([]);
      expect(controller('ClassSocketPolicyRoutes').policies).to.deep.equal([]);
    });

    it('keeps @Policy and @Access as guards of a route', () => {
      expect(route('MixedRoutes', 'policy').policies).to.deep.equal([[{ type: 'OpenPolicy', options: [] }]]);
      expect(route('MixedRoutes', 'access').policies).to.deep.equal([[{ type: 'AccessPolicy', options: ['route'] }]]);
    });

    it('leaves such a route unguarded for the doctor (HTTP002), without a build warning', () => {
      const found = routeWithoutPolicy.run(fixture({ controllers: lib.controllers }), doctorCtx).map((d) => d.message.split(' is a route')[0]);
      expect(found).to.have.members(['MixedRoutes.socketPolicy', 'ClassSocketPolicyRoutes.x']);
      expect(lib.diagnostics.filter((d) => d.code === 'AUTHZ013' && d.source?.file.endsWith('routes.ts'))).to.deep.equal([]);
    });
  });

  // Known gap, closed by a later branch: the options of a socket entry come from the first of @Access / @SocketAccess.
  it('takes the options of an @Access written above @SocketAccess, which makes the manifest stricter than the run time, and warns there', () => {
    expect(command(lib, 'GapSocket', 'peek').policies).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['handler'] }]]);
    expect(entryPoint(lib, 'gap.peek')?.access).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['gap:socket'] }]]);
    expect(lib.diagnostics.some((d) => d.code === 'AUTHZ013' && lineAt(d.source!.line) === "@Access('gap:http')")).to.equal(true);
  });
});
