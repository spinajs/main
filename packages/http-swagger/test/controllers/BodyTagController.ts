import { BaseController, BasePath, Body, Ok, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  required: ['login', 'password'],
  properties: {
    login: { type: 'string' },
    password: { type: 'string' },
  },
})
export class BodyTagLoginDto {
  login?: string;
  password?: string;
}

@Schema({
  type: 'object',
  required: ['MfaRequired'],
  properties: {
    MfaRequired: { type: 'array', items: { type: 'string' } },
  },
})
export class BodyTagPendingDto {
  MfaRequired?: string[];
}

// The members are named-type tags: each becomes a $ref to its own component.
@Schema({
  oneOf: [
    { type: 'object', description: 'BodyTagPendingDto' },
    { type: 'object', description: 'BodyTagLoginDto' },
  ],
})
export class BodyTagAnswerDto {}

@Schema({
  type: 'object',
  properties: { note: { type: 'string' } },
})
export class BodyTagDeclaredDto {
  note?: string;
}

/**
 * Routes that read their JSON body from `@Req()` and name its type with `@body`.
 * @tags BodyTag
 */
@BasePath('body-tag')
export class BodyTagController extends BaseController {
  /**
   * Log in
   * @body {BodyTagLoginDto} The credentials
   * @returns {BodyTagAnswerDto} The session answer
   */
  @Post('login')
  public async login(@Req() req: Request) {
    return new Ok(req.body);
  }

  /**
   * Untyped body tag
   * @body no type, so no request body
   */
  @Post('untyped')
  public async untyped(@Req() req: Request) {
    return new Ok(req.body);
  }

  /**
   * A body argument wins over the tag
   * @body {BodyTagLoginDto} not used
   */
  @Post('declared')
  public async declared(@Body() data: BodyTagDeclaredDto) {
    return new Ok(data);
  }
}
