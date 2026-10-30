import { BaseController, BasePath, Body, Cookie, File, Files, Form, FormField, Get, Header, NoContent, Param, Post, Query, QueryField } from '@spinajs/http';
import type { IUploadedFile } from '@spinajs/http';

export type Meta = { level: number; tags: string[] };
export type Filter = { page?: number; q?: string };
export type CreateDto = { email: string };
export type Profile = { name: string; address: { city: string; zip: string }; langs: string[] };

/** The route arguments each action was called with, keyed by handler. */
export const received: Record<string, unknown[]> = {};

function seen(handler: string, ...args: unknown[]): NoContent<void> {
  received[handler] = args;
  return new NoContent<void>(null);
}

/** One route per argument wire shape the app-basic fixture does not cover. */
@BasePath('wire')
export class WireController extends BaseController {
  @Get('values')
  public async values(@Query() page: number, @Query() verbose: boolean, @Query() since: Date): Promise<NoContent<void>> {
    return seen('values', page, verbose, since);
  }

  @Get('whole-query')
  public async wholeQuery(@QueryField() filter: Filter): Promise<NoContent<void>> {
    return seen('wholeQuery', filter);
  }

  @Get('headers')
  public async headers(@Header('X-Tenant') tenant: string, @Header('x-meta') meta: Meta): Promise<NoContent<void>> {
    return seen('headers', tenant, meta);
  }

  @Get('cookie')
  public async cookie(@Cookie() session: string): Promise<NoContent<void>> {
    return seen('cookie', session);
  }

  @Post('fields')
  public async fields(@Body() user: CreateDto, @Body() note: string): Promise<NoContent<void>> {
    return seen('fields', user, note);
  }

  @Post('primitive')
  public async primitive(@Body() email: string): Promise<NoContent<void>> {
    return seen('primitive', email);
  }

  @Post('photos')
  public async photos(@Files() photos: IUploadedFile[], @FormField() title: string, @FormField() meta: Meta, @FormField() tags: string[]): Promise<NoContent<void>> {
    return seen('photos', photos, title, meta, tags);
  }

  @Post('profile')
  public async profile(@Form() profile: Profile): Promise<NoContent<void>> {
    return seen('profile', profile);
  }

  @Get('optional{/:id}')
  public async optional(@Param() id?: number): Promise<NoContent<void>> {
    return seen('optional', id);
  }

  @Get('tree/*path')
  public async tree(@Param() path: string[]): Promise<NoContent<void>> {
    return seen('tree', path);
  }
}

/** A `@Body` next to a file: the generator refuses it, because the server binds no body from a multipart request. */
@BasePath('mixed')
export class MixedController extends BaseController {
  @Post('upload')
  public async upload(@File() file: IUploadedFile, @Body() meta: Meta): Promise<NoContent<void>> {
    return seen('mixedUpload', file, meta);
  }
}
