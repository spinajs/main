import { BaseController, BasePath, Post, Body, Ok } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

class RefTarget { public name = 'RefTarget'; } // stand-in target model

@Schema({
  type: 'object',
  $id: 'swagger.test.RelDto',
  properties: {
    author: { type: 'string', format: 'uuid' },
  },
})
class RelDto {
  public author: string;
  constructor(data: any) { Object.assign(this, data); }
}

// Emulate what orm-http's @Relation writes onto the DTO prototype.
Reflect.defineMetadata(
  Symbol.for('orm-http:relations'),
  { Relations: new Map([['author', { field: 'author', target: () => RefTarget, by: 'Uuid' }]]) },
  RelDto.prototype,
);

@BasePath('rel')
export class RelationController extends BaseController {
  @Post()
  public create(@Body() _dto: RelDto) {
    return new Ok();
  }
}
