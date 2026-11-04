import { DateTime } from 'luxon';
import { BaseController, BasePath, Body, Get, Ok, Param, Post, Query } from '@spinajs/http';
import type { Big } from './vendor/@types/big.js/index.js';
import type { Decimal } from './vendor/decimal.js/decimal.js';

export type AuthorDto = { id: number; name: string; joinedAt: Date };
export type LineDto = { sku: string; price: Decimal; tax?: Big };
export type StampDto = { at: Date };
export type AuditDto = StampDto & { by: string };
export type CircleDto = { kind: 'circle'; radius: number; drawnAt: Date };
export type SquareDto = { kind: 'square'; side: number };
export type ShapeDto = CircleDto | SquareDto;

export type ArticleDto = {
  id: number;
  title: string;
  publishedAt: Date;
  reviewedAt: DateTime;
  total: Decimal;
  views: bigint;
  author: AuthorDto;
  lines: LineDto[];
  shape: ShapeDto;
  audit: AuditDto;
  closedAt?: Date | null;
};

/** The wire form of `ArticleDto`: dates as ISO text, decimals and bigints as strings. */
export const SAMPLE = {
  id: 1,
  title: 'Models',
  publishedAt: '2026-01-02T03:04:05.000Z',
  reviewedAt: '2026-02-03T04:05:06.000Z',
  total: '12.50',
  views: '9007199254740993',
  author: { id: 7, name: 'Ada', joinedAt: '2025-12-31T23:59:59.000Z' },
  lines: [
    { sku: 'a', price: '1.25', tax: '0.10' },
    { sku: 'b', price: '11.25' },
  ],
  shape: { kind: 'circle', radius: 2, drawnAt: '2026-03-04T05:06:07.000Z' },
  audit: { at: '2026-04-05T06:07:08.000Z', by: 'grace' },
  closedAt: null,
};

/** What the actions received, keyed by handler. */
export const received: Record<string, unknown[]> = {};

function seen<T>(handler: string, reply: T, ...args: unknown[]): Ok<T> {
  received[handler] = args;
  return new Ok(reply);
}

@BasePath('articles')
export class ArticlesController extends BaseController {
  @Get('since')
  public async since(@Query() from: Date): Promise<Ok<ArticleDto[]>> {
    return seen('since', [SAMPLE as unknown as ArticleDto], from);
  }

  @Get('on/:day')
  public async on(@Param() day: Date): Promise<Ok<ArticleDto[]>> {
    return seen('on', [SAMPLE as unknown as ArticleDto], day);
  }

  @Get(':id')
  public async get(@Param() id: number): Promise<Ok<ArticleDto>> {
    return seen('get', SAMPLE as unknown as ArticleDto, id);
  }

  @Post()
  public async save(@Body() article: ArticleDto): Promise<Ok<ArticleDto>> {
    return seen('save', article, article);
  }
}
