import { BaseController, BasePath, Get, Post, Query, Param, Body, Ok, Json, Created } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

/**
 * Pagination parameters DTO.
 */
@Schema({
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
})
class PaginationDto {
  page?: number;
  limit?: number;
}

/**
 * A named DTO used to document a list response through `@returns {TypedPetDto[]}`.
 */
@Schema({
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
  },
})
class TypedPetDto {
  id?: number;
  name?: string;
}

/**
 * Test controller for generic response type inference.
 * Exercises Ok<T>, Json<T>, Created<T>, and @Schema DTO parameter inference.
 * @tags TypedTests
 */
@BasePath('typed')
export class TypedController extends BaseController {
  /**
   * Get a typed pet via Ok<T>
   * Demonstrates inline object schema inference through the Ok<T> wrapper.
   * @param id The pet ID
   */
  @Get('ok/:id')
  public async okTyped(@Param() id: number): Promise<Ok<{ id: number; name: string; available: boolean }>> {
    return new Ok({ id, name: 'Buddy', available: true });
  }

  /**
   * List typed pets via Ok<T[]>
   * Demonstrates array schema inference through the Ok<T[]> wrapper.
   */
  @Get('ok-array')
  public async okArrayTyped(): Promise<Ok<Array<{ id: number; name: string }>>> {
    return new Ok([{ id: 1, name: 'Buddy' }]);
  }

  /**
   * Get a typed pet via Json<T>
   * Demonstrates inline object schema inference through the Json<T> wrapper.
   * @param id The pet ID
   */
  @Get('json/:id')
  public async jsonTyped(@Param() id: number): Promise<Json<{ id: number; name: string }>> {
    return new Json({ id, name: 'Buddy' });
  }

  /**
   * Create a typed pet via Created<T>
   * Demonstrates inline object schema inference through the Created<T> wrapper.
   */
  @Post('created')
  public async createdTyped(@Body() data: object): Promise<Created<{ id: number; name: string }>> {
    void data;
    return new Created({ id: 1, name: 'New Pet' });
  }

  /**
   * List pets with DTO pagination parameter
   * Demonstrates schema extraction from a @Schema-decorated DTO class.
   * @param pagination Pagination options
   */
  @Get('paginated')
  public async paginated(@Query() pagination?: PaginationDto): Promise<Ok<Array<{ id: number }>>> {
    void pagination;
    return new Ok([{ id: 1 }]);
  }

  /**
   * Get current user profile (requires authentication)
   * Returns profile data for the logged-in user.
   * @security cookieAuth
   */
  @Get('profile')
  public async profile(): Promise<Ok<{ userId: number; name: string }>> {
    return new Ok({ userId: 1, name: 'Alice' });
  }

  /**
   * List pets documented as a named array
   * The `[]` has to survive as an array schema whose items reference the DTO component;
   * documenting the list as a bare object made a client reject every response.
   * @returns {TypedPetDto[]} Every pet
   */
  @Get('returns-named-array')
  public async returnsNamedArray(): Promise<Ok<TypedPetDto[]>> {
    return new Ok([{ id: 1, name: 'Buddy' }]);
  }

  /**
   * List pet names
   * @returns {string[]} Pet names
   */
  @Get('returns-primitive-array')
  public async returnsPrimitiveArray(): Promise<Ok<string[]>> {
    return new Ok(['Buddy']);
  }

  /**
   * Public endpoint — no authentication required
   * Returns server status.
   * @security []
   */
  @Get('public-status')
  public async publicStatus(): Promise<Ok<{ status: string }>> {
    return new Ok({ status: 'ok' });
  }
}
