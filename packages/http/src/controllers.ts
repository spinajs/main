import Express from 'express';

import { AsyncService, IContainer, Autoinject, DI, ClassInfo, Container, Class } from '@spinajs/di';
import { ListFromFiles } from '@spinajs/reflection';
import { Logger, Log } from '@spinajs/log';
import { HttpServer } from './server.js';
import { uniqueBy } from '@spinajs/util';
import { DefaultControllerCache } from './cache.js';
import { BaseController } from './base-controller.js';

export class Controllers extends AsyncService {
  /**
   * File-scanned controller types (no instances). Each entry's `type` is
   * registered as `BaseController` in DI during `resolve()`, then every
   * controller — file-scanned and bootstrapper-registered alike — is
   * resolved through `Array.ofType(BaseController)`.
   */
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers!: Promise<Array<ClassInfo<BaseController>>>;

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
    const instance = (await DI.resolve(type)) as BaseController;

    const ci = new ClassInfo<BaseController>();
    ci.name = type.name;
    ci.type = type;
    ci.instance = instance;
    // Source file was captured at decoration time by the route decorators.
    // Sentinel only if nothing was captured (no route decorators ran).
    ci.file = instance.Descriptor?.SourceFile ?? '<dynamic>';

    await this.register(ci);
  }

  public async register(controller: ClassInfo<BaseController>) {
    this.Log.trace(`Loading controller: ${controller.name}`);

    if (controller.type && this.RegisteredTypes.has(controller.type)) {
      this.Log.trace(`Controller ${controller.name} already registered, skipping`);
      return;
    }

    const parameters = await this.ControllersCache.getCache(controller);
    if (!controller.instance) {
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} is not resolved. Make sure it is decorated with @injectable and has a public constructor without required parameters`);
      return;
    }

    if (!controller.instance.Descriptor) {
      this.Log.warn(`Controller ${controller.name} in file ${controller.file} dont have descriptor or routes defined`);
    } else {
      for (const [name, route] of controller.instance.Descriptor.Routes) {
        if (parameters[name as string]) {
          const member = parameters[name as string];

          for (const [index, rParam] of route.Parameters) {
            const pName = member[index];
            if (pName) {
              rParam.Name = pName;
            }
          }
        } else {
          this.Log.error(`Controller ${controller.name} does not have member ${name as string} for route ${route.Path}`);
        }
      }

      if (!controller.instance.Router) {
        this.Log.warn(`Controller ${controller.name} in file ${controller.file} has no router instance. Check if it extends BaseController and super.resolve() is called in resolve method`);
        return;
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

    // Two registration paths converge here:
    //  1. Directory-scanned controllers (existing behavior). @ListFromFiles
    //     hands us the class types; we register each as `BaseController` so
    //     they show up in the DI collection.
    //  2. Bootstrapper-registered controllers. A package's Bootstrapper can
    //     conditionally call `DI.register(MyController).as(BaseController)`
    //     before this service resolves. Those classes are already in the
    //     collection by the time we get here.
    // Resolving `Array.ofType(BaseController)` then instantiates everything
    // in a single pass — file-scanned + bootstrap-registered, with class
    // identity dedupe (multiple `as(BaseController)` calls for the same type
    // resolve to one singleton).
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
