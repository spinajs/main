import Express from 'express';

import { AsyncService, IContainer, Autoinject, DI, ClassInfo, Container, Class } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { HttpServer } from './server.js';
import { uniqueBy } from '@spinajs/util';
import { DefaultControllerCache, parseFnParamNames, isOnDiskSource } from './cache.js';
import { BaseController } from './base-controller.js';
import { ControllerSource } from './controller-sources.js';
import { ControllerRegistrationException, RouteRegistrationException } from './exceptions.js';

export class Controllers extends AsyncService {
  /**
   * Merged, deduped controller list from all registered
   * {@link ControllerSource} services (no instances until `resolve()` patches
   * them in). Kept as a public accessor for API compatibility — http-swagger
   * and app code read it to enumerate controllers.
   */
  public get Controllers(): Promise<Array<ClassInfo<BaseController>>> {
    return (this._listed ??= this.listControllers());
  }

  private _listed?: Promise<Array<ClassInfo<BaseController>>>;

  @Logger('http')
  protected Log!: Log;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject()
  protected Server!: HttpServer;

  @Autoinject()
  protected ControllersCache!: DefaultControllerCache;

  /**
   * Single Express router that all controllers' routers are mounted onto.
   * It occupies one fixed position in the parent Express stack, so
   * dynamically-added controllers (via {@link add}) land at the right place
   * automatically — Express evaluates sub-router stacks lazily on each
   * request. NotFound / Error middleware live AFTER this router via the
   * standard ServerMiddleware.after() lifecycle.
   */
  protected ControllersRouter!: Express.Router;

  /**
   * Tracks which controller types have already been route-registered so
   * {@link add} is idempotent.
   */
  protected RegisteredTypes: Set<Class<BaseController>> = new Set();

  /**
   * Resolves all registered controller discovery services. Override point
   * for tests and for apps that want full control over discovery.
   */
  protected async getSources(): Promise<ControllerSource[]> {
    return (await DI.resolve(Array.ofType(ControllerSource))) as ControllerSource[];
  }

  /**
   * Gathers controllers from every source and dedupes them: for the same
   * type an entry with a real on-disk file wins over a `<di>` / `<dynamic>`
   * sentinel (the file path feeds ControllersCache source parsing).
   */
  protected async listControllers(): Promise<Array<ClassInfo<BaseController>>> {
    const sources = await this.getSources();
    const lists = await Promise.all(sources.map((s) => s.getControllers()));

    const byType = new Map<Class<BaseController>, ClassInfo<BaseController>>();
    const untyped: Array<ClassInfo<BaseController>> = [];

    for (const ci of lists.flat()) {
      if (!ci.type) {
        untyped.push(ci);
        continue;
      }

      const existing = byType.get(ci.type as Class<BaseController>);
      if (!existing || (!isOnDiskSource(existing.file) && isOnDiskSource(ci.file))) {
        byType.set(ci.type as Class<BaseController>, ci);
      }
    }

    return [...byType.values(), ...untyped];
  }

  /**
   * Dynamically register a controller after startup. Equivalent to having
   * declared it via @Injectable / file-scan / bootstrapper registration
   * before `resolve()` ran, but usable at any point.
   *
   * Registers the type as BaseController (idempotent), resolves the
   * singleton instance, runs the per-controller cache + descriptor setup,
   * and mounts the controller's Router on the shared ControllersRouter.
   *
   * No Express stack mutation needed: the shared router was mounted once
   * during resolve() and lives at a fixed slot; the new controller's router
   * just becomes another entry in the shared router's internal stack.
   */
  public async add(type: Class<BaseController>): Promise<void> {
    if (this.RegisteredTypes.has(type)) {
      this.Log.trace(`Controller ${type.name} already registered, skipping`);
      return;
    }

    DI.register(type as any).as(BaseController);

    try {
      const instance = (await DI.resolve(type)) as BaseController;

      const ci = new ClassInfo<BaseController>();
      ci.name = type.name;
      ci.type = type;
      ci.instance = instance;
      // Source file was captured at decoration time by the route decorators.
      // Sentinel only if nothing was captured (no route decorators ran).
      ci.file = instance.Descriptor?.SourceFile ?? '<dynamic>';

      await this.register(ci);
    } catch (err) {
      // Roll back so the broken type is not silently mounted by a later
      // Array.ofType(BaseController) resolve, and so a fixed retry can
      // register cleanly.
      DI.unregister(type);
      DI.uncache(BaseController);
      throw err;
    }
  }

  public async register(controller: ClassInfo<BaseController>) {
    this.Log.trace(`Loading controller: ${controller.name}`);

    if (controller.type && this.RegisteredTypes.has(controller.type)) {
      this.Log.trace(`Controller ${controller.name} already registered, skipping`);
      return;
    }

    if (!controller.instance) {
      throw new ControllerRegistrationException(
        `Controller ${controller.name} in file ${controller.file} is not resolved. Make sure it is decorated with @injectable and has a public constructor without required parameters`,
      );
    }

    const parameters = await this.ControllersCache.getCache(controller);

    if (!controller.instance.Descriptor) {
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} dont have descriptor or routes defined`);
    } else {
      for (const [name, route] of controller.instance.Descriptor.Routes) {
        let member = parameters[name as string];

        if (!member) {
          const action = (controller.instance as any)[name as string];
          if (typeof action !== 'function') {
            throw new RouteRegistrationException(`Controller ${controller.name} does not have member ${String(name)} for route ${route.Path}`);
          }

          // Route inherited from a base class declared in another source file
          // — the parsed source of THIS class has no such member. Extract
          // parameter names from the runtime function instead.
          member = parseFnParamNames(action);
        }

        for (const [index, rParam] of route.Parameters) {
          const pName = member[index];
          if (pName) {
            rParam.Name = pName;
          }
        }
      }

      if (!controller.instance.Router) {
        throw new ControllerRegistrationException(
          `Controller ${controller.name} in file ${controller.file} has no router instance. Check if it extends BaseController and super.resolve() is called in resolve method`,
        );
      }

      this.ControllersRouter.use(controller.instance.Router);
      if (controller.type) {
        this.RegisteredTypes.add(controller.type);
      }
    }
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    // Shared sub-router. All controller routers mount onto this one; this
    // one mounts onto Express exactly once. Dynamic adds land here too,
    // which is how `add()` avoids the old Express-stack juggling.
    this.ControllersRouter = Express.Router();

    // Discovery is delegated to ControllerSource services (filesystem scan,
    // DI registry, custom app sources). All lists are merged and deduped in
    // listControllers(); each discovered type is registered as
    // `BaseController` below, then resolving `Array.ofType(BaseController)`
    // instantiates everything in a single pass with class-identity dedupe
    // (multiple `as(BaseController)` calls for the same type resolve to one
    // singleton).
    const listed = await this.Controllers;

    // Remember the original file path per type so the second loop can preserve
    // it. Without this every controller would end up tagged `<di>`, breaking
    // ControllersCache.getCache() which expects a real on-disk source file.
    const fileByType = new Map<Class<BaseController>, ClassInfo<BaseController>>();

    for (const ci of uniqueBy(listed, (c) => c.name)) {
      if (!ci.type) {
        this.Log.warn(`Controller ${ci.name} in file ${ci.file} has no type. Make sure it is decorated with @injectable and has a public constructor without required parameters`);
        continue;
      }

      fileByType.set(ci.type as Class<BaseController>, ci);
      DI.register(ci.type).as(BaseController);
      this.Log.trace(`Controller ${ci.name} from ${ci.file} registered as BaseController`);
    }

    const instances = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];

    // Report on scanned controllers that someone else derives from. Both
    // outcomes are otherwise invisible: an override leaves no trace at all, and
    // an accidental shadow leaves two controllers answering the same paths.
    const mounted = new Set(instances.map((i) => i.constructor as Class<BaseController>));

    for (const [type, ci] of fileByType) {
      // Something that mounted derives from this scanned controller. Keying off
      // the descendant rather than off `mounted` is what lets both cases be
      // seen — in the not-registered case the scanned type mounts too.
      const descendant = instances.find((i) => i.constructor !== type && i instanceof type);

      if (!descendant) {
        continue;
      }

      if (!mounted.has(type)) {
        // Scanned, yet absent from the collection — DI chained its registration
        // to the subclass. Say so rather than dropping it silently.
        this.Log.info(`Controller ${ci.name} overridden by ${descendant.constructor.name}`);
      } else {
        // Subclassed but never registered as an override, so BOTH mounted and
        // Express route order picks the winner. Warn rather than throw, since
        // legitimate shared bases exist ( eg. abstract Crud in orm-api ).
        this.Log.warn(`Controller ${descendant.constructor.name} extends ${ci.name} but was not registered as an override. Call DI.register(${descendant.constructor.name}).as(${ci.name}) to replace it, otherwise both mount and route order decides which one answers.`);
      }
    }

    for (const instance of instances) {
      const type = instance.constructor as Class<BaseController>;
      const originalCi = fileByType.get(type);
      const ci =
        originalCi ??
        Object.assign(new ClassInfo<BaseController>(), {
          name: type.name,
          type,
          instance,
          // For DI-registered controllers without a file scan entry, fall back
          // to the source file captured at decoration time by `Controller()`.
          // Only sentinel '<di>' if nothing was captured (abstract base, or no
          // route decorators ran).
          file: instance.Descriptor?.SourceFile ?? '<di>',
        } as Partial<ClassInfo<BaseController>>);
      // The file-scanned entry has no instance (List, not Resolve) — patch it.
      if (!ci.instance) ci.instance = instance;
      await this.register(ci);
    }

    // Mount the shared controllers router on the Express app ONCE. From here
    // on, anything added via `this.ControllersRouter.use(...)` (including
    // future `add()` calls) is picked up by Express automatically.
    // NotFound / Error handling is handled by NotFoundMiddleware and
    // ErrorHandlerMiddleware (ServerMiddleware impls), attached to the
    // Express stack tail during HttpServer.start().
    this.Server.use(this.ControllersRouter);
  }
}
