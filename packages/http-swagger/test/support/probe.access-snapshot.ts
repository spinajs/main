// Runs in a fresh node process (ts-node/esm): builds the document of a fixture controller that uses
// the real @spinajs/authz-http decorators, and prints it next to authz-http's own swaggerAccess.
import 'reflect-metadata';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Model, ModelBase, Primary } from '@spinajs/orm';
import { Access, AllowAnonymous, Unscoped, UnfilteredInput, fromBody, fromModel, fromParam, fromQuery, swaggerAccess, typedExtractor } from '@spinajs/authz-http';
import { OpenApiBuilder } from '../../src/openapi-builder.js';

@Model('snapshot_docs')
class SnapshotDoc extends ModelBase {
  @Primary()
  public Id: string;
}

@BasePath('snap')
@Access('project:read')
class SnapshotController extends BaseController {
  @Get('inherited')
  public inherited() {
    return new Ok({});
  }

  @Get('param/:uuid')
  @Access(['user:read', 'user:list'], { resource: fromParam('uuid', 'user', { by: 'Uuid' }), domain: 'tenant' })
  public byParam() {
    return new Ok({});
  }

  @Get('query')
  @Access('order:read', { resource: fromQuery('order', 'order') })
  public byQuery() {
    return new Ok({});
  }

  @Get('body')
  @Access('invoice:create', { resource: fromBody('invoice.id', 'invoice'), domain: 'root' })
  public byBody() {
    return new Ok({});
  }

  @Get('model/:doc')
  @Access('doc:update', { resource: fromModel(SnapshotDoc, 'doc') })
  @Unscoped('export')
  @UnfilteredInput('imports raw documents')
  public byModel() {
    return new Ok({});
  }

  @Get('open')
  @AllowAnonymous()
  @Access('file:read', { resource: typedExtractor('file', () => ({ type: 'file' })) })
  public open() {
    return new Ok({});
  }

  @Get('custom')
  @Access('file:read', { resource: () => ({ type: 'file' }) })
  public custom() {
    return new Ok({});
  }
}

class PlainController extends BaseController {
  @Get('x')
  public x() {
    return new Ok({});
  }
}

const builder = new OpenApiBuilder({ enabled: true, title: 'snapshot', version: '1.0.0' });
const controllers = [SnapshotController, PlainController].map((c) => ({ name: c.name, instance: new c() }));
for (const c of controllers) {
  builder.addController(c as any, { className: c.name, methods: {} });
}
const doc = builder.build();

const out: unknown[] = [];
for (const c of controllers) {
  for (const [name, route] of c.instance.Descriptor.Routes) {
    const method = String(route.Type).toLowerCase();
    const path = Object.keys(doc.paths).find((p) => doc.paths[p][method]?.operationId === `${c.name}_${String(name)}`)!;
    const op: any = doc.paths[path][method];
    out.push({
      route: `${method.toUpperCase()} ${path}`,
      extensions: Object.fromEntries(Object.entries(op).filter(([k]) => k.startsWith('x-authz-'))),
      access: /\*\*Access:\*\*[^\n]*/.exec(op.description ?? '')?.[0] ?? null,
      responses: Object.keys(op.responses).sort(),
      swaggerAccess: swaggerAccess(c.instance, name as string) ?? null,
    });
  }
}
out.sort((a: any, b: any) => a.route.localeCompare(b.route));

process.stdout.write(`<<JSON\n${JSON.stringify(out, null, 2)}\nJSON>>\n`);
process.exit(0);
