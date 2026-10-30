import { BaseController, BasePath, Body, Get, Ok, Post } from '@spinajs/http';
import type { ModelBase } from '@spinajs/orm';
import type { User } from '@spinajs/users';
import { Author } from './models.js';
import { Shelf } from './shelf.js';

export type RenamedAuthor = { [K in keyof Author as `get${K & string}`]: Author[K] };
/** Same shape as RenamedAuthor; the test strips the TS-internal origin links from it. */
export type RenamedAuthorUnlinked = { [K in keyof Author as `get${K & string}`]: Author[K] };
export type Renamed<T> = { [K in keyof T as `x_${K & string}`]: T[K] };
export type Upper<T> = { [K in keyof T as Uppercase<K & string>]: T[K] };
export type PublicOf<T> = T extends ModelBase<infer _> ? { [K in keyof T as `api_${K & string}`]: T[K] } : never;
export type InlineKeys = { [K in 'Id' | 'Password']: Author[K] };
export type InlineShelfKeys = { [K in 'Id' | 'Password']: Shelf[K] };
export type Labels = Record<'en' | 'pl', string>;

export interface IPoint {
  X: number;
  Y?: string;
}

export interface IRenamedView extends RenamedAuthor {
  Shown: boolean;
}

export interface IListing<T> {
  items: T[];
  total: number;
}

@BasePath('remapped')
export class RemappedController extends BaseController {
  @Get('author')
  public async author(): Promise<Ok<RenamedAuthor>> {
    return new Ok(undefined as unknown as RenamedAuthor);
  }
  @Get('unlinked')
  public async unlinked(): Promise<Ok<RenamedAuthorUnlinked>> {
    return new Ok(undefined as unknown as RenamedAuthorUnlinked);
  }
  @Get('generic')
  public async generic(): Promise<Ok<Renamed<Author>>> {
    return new Ok(undefined as unknown as Renamed<Author>);
  }
  @Get('upper')
  public async upper(): Promise<Ok<Upper<Author>>> {
    return new Ok(undefined as unknown as Upper<Author>);
  }
  @Get('conditional')
  public async conditional(): Promise<Ok<PublicOf<Author>>> {
    return new Ok(undefined as unknown as PublicOf<Author>);
  }
  @Get('view')
  public async view(): Promise<Ok<IRenamedView>> {
    return new Ok(undefined as unknown as IRenamedView);
  }
  @Get('listing')
  public async listing(): Promise<Ok<IListing<RenamedAuthor>>> {
    return new Ok({ items: [], total: 0 });
  }
  @Post('body')
  public async body(@Body() body: Renamed<Author>): Promise<Ok<Renamed<IPoint>>> {
    void body;
    return new Ok({ x_X: 1 });
  }
  @Get('inline')
  public async inline(): Promise<Ok<InlineKeys>> {
    return new Ok({ Id: 1, Password: '' });
  }
  @Get('shelf')
  public async shelf(): Promise<Ok<Renamed<Shelf>>> {
    return new Ok(undefined as unknown as Renamed<Shelf>);
  }
  @Get('shelf-inline')
  public async shelfInline(): Promise<Ok<InlineShelfKeys>> {
    return new Ok({ Id: 1, Password: '' });
  }
  @Get('user')
  public async user(): Promise<Ok<PublicOf<User>>> {
    return new Ok(undefined as unknown as PublicOf<User>);
  }
  @Get('labels')
  public async labels(): Promise<Ok<Labels>> {
    return new Ok({ en: '', pl: '' });
  }
}
