import { Autoinject, Class, DI, Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ArgHydrator, IRouteParameter, extractSchemaFromRuntimeType } from '@spinajs/http';
import { DataValidator } from '@spinajs/validation';
import { ISocketCallContext, ISocketParameter, SocketArg } from './interfaces.js';

const PLAIN_TYPES = new Set<unknown>([Object, Array, String, Number, Boolean]);

interface IHydratorMetadata {
  hydrator: Class<ArgHydrator>;
  options: unknown[] | null;
}

/**
 * The payload, validated against the command `schema`, else the `@Payload(schema)`, else the DTO's
 * `@Schema`, then hydrated as http hydrates a body ( `@Hydrator`, else `new Dto(payload)` ).
 */
@Injectable()
export class PayloadArg extends SocketArg {
  @Autoinject()
  protected Validator: DataValidator;

  public async extract(ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown> {
    const payload = ctx.payload;
    const schema = ctx.handler?.descriptor.Options.schema ?? param.Schema ?? this.schemaOfType(param.RuntimeType);

    if (schema) {
      // DataValidator.validate(schema, undefined) would validate the schema object itself
      if (payload === undefined || payload === null) {
        throw new InvalidArgument('payload is required');
      }

      this.Validator.validate(schema, payload as object);
    }

    return this.hydrate(payload, param);
  }

  protected schemaOfType(type: unknown): object | null {
    if (typeof type !== 'function' || PLAIN_TYPES.has(type)) {
      return null;
    }

    return (extractSchemaFromRuntimeType(type, this.Validator) as object | undefined) ?? null;
  }

  protected async hydrate(payload: unknown, param: ISocketParameter): Promise<unknown> {
    const type = param.RuntimeType;

    if (payload === undefined || payload === null || typeof type !== 'function' || PLAIN_TYPES.has(type)) {
      return payload;
    }

    const meta = Reflect.getMetadata('custom:arg_hydrator', type) as IHydratorMetadata | undefined;
    if (meta) {
      const hydrator = await DI.resolve<ArgHydrator>(meta.hydrator, meta.options ?? undefined);
      return hydrator.hydrate(payload, param as unknown as IRouteParameter);
    }

    return new (type as new (data: unknown) => unknown)(payload);
  }
}

@Injectable()
export class ConnectionArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.connection;
  }
}

@Injectable()
export class SignalArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.signal;
  }
}

@Injectable()
export class ReasonArg extends SocketArg {
  public async extract(ctx: ISocketCallContext): Promise<unknown> {
    return ctx.reason ?? null;
  }
}

@Injectable()
export class FromDiArg extends SocketArg {
  public async extract(_ctx: ISocketCallContext, param: ISocketParameter): Promise<unknown> {
    return DI.resolve(param.RuntimeType as Class<unknown>, param.Options as unknown[] | undefined);
  }
}

@Injectable()
export class SocketArgumentResolver {
  public async resolve(ctx: ISocketCallContext): Promise<unknown[]> {
    const handler = ctx.handler;
    if (!handler) {
      throw new InvalidArgument('socket handler arguments cannot be resolved before the handler is known');
    }

    const params = [...handler.descriptor.Parameters.values()];
    const args = new Array<unknown>(params.reduce((max, p) => Math.max(max, p.Index + 1), 0));

    for (const param of params) {
      const extractor = (await DI.resolve(param.Type)) as SocketArg;
      args[param.Index] = await extractor.extract(ctx, param);
    }

    return args;
  }
}
