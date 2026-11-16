import { BaseController, BasePath, Body, Get, NoContent, Param, Post, Query, QueryField } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

export type Nullable<T> = T | null;

export interface Circle {
  kind: 'circle';
  radius: number;
}

export interface Square {
  kind: 'square';
  side: number;
}

export type Figure = Circle | Square;

export interface Category {
  name: string;
  children?: Category[];
  parent?: Nullable<Category>;
}

export interface Geo {
  at: [number, number];
  path: [string, ...number[]];
  label?: [string, number?];
  area: Nullable<number>;
  /** @minItems 1 @maxItems 3 */
  stops: string[];
}

export interface Named {
  name: string;
}

export interface Aged {
  age: number;
}

export type Person = Named & Aged;

export interface SignUpDto {
  /** @format email */
  email: string;
  /**
   * Shown to other users.
   * @minLength 2
   * @maxLength 64
   */
  name: string;
  /** @pattern ^[a-z]+$ */
  handle?: string;
  /**
   * @minimum 18
   * @exclusiveMaximum 130
   */
  age: number;
  /** @uniqueItems */
  tags: string[];
  /** @format date-time */
  born?: string;
  nickname: string | null;
  role: 'admin' | 'user';
  big: bigint;
  /** @format zip-code */
  zip?: string;
  /** @multipleOf 0.5 */
  score?: number;
}

export interface PageQuery {
  page?: number;
  q?: string;
}

@Schema({
  type: 'object',
  properties: { home: { $ref: '#/$defs/address' }, work: { $ref: '#/$defs/address' } },
  required: ['home'],
  additionalProperties: false,
  $defs: { address: { type: 'object', properties: { city: { type: 'string', minLength: 1 } }, required: ['city'], additionalProperties: false } },
})
export class AddressBook {
  public home: { city: string };
  public work?: { city: string };
}

interface LocalStandard {
  readonly '~standard': { readonly version: 1; readonly vendor: 'my-lib'; readonly validate: (value: unknown) => { value: unknown } };
}
declare const localStandard: LocalStandard;

/** A Standard Schema the compiler cannot read: the manifest carries the derived shape, marked partial. */
@Schema(localStandard)
export class Feedback {
  public text: string;
}

function accepted(..._args: unknown[]): NoContent<void> {
  return new NoContent<void>(null);
}

/** One route per schema shape the zod emitter maps. */
@BasePath('corpus')
export class CorpusController extends BaseController {
  @Post('signup')
  public async signUp(@Body() body: SignUpDto): Promise<NoContent<void>> {
    return accepted(body);
  }

  @Post('figure')
  public async figure(@Body() figure: Figure): Promise<NoContent<void>> {
    return accepted(figure);
  }

  @Post('tree')
  public async tree(@Body() root: Category): Promise<NoContent<void>> {
    return accepted(root);
  }

  @Post('geo')
  public async geo(@Body() geo: Geo): Promise<NoContent<void>> {
    return accepted(geo);
  }

  @Post('people')
  public async people(@Body() person: Person): Promise<NoContent<void>> {
    return accepted(person);
  }

  @Get('search')
  public async search(@QueryField() filter: PageQuery, @Query() limit: number): Promise<NoContent<void>> {
    return accepted(filter, limit);
  }

  @Post('addresses')
  public async addresses(@Body() book: AddressBook): Promise<NoContent<void>> {
    return accepted(book);
  }

  @Post('feedback')
  public async feedback(@Body() feedback: Feedback): Promise<NoContent<void>> {
    return accepted(feedback);
  }

  @Post('note')
  public async note(@Body() title: string, @Body() text: string): Promise<NoContent<void>> {
    return accepted(title, text);
  }

  @Get('item/:id')
  public async item(@Param() id: number): Promise<Category> {
    return { name: String(id) };
  }
}
