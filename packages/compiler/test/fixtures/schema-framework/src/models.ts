import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { BelongsTo, HasMany, Hidden, Model, ModelBase, Primary, Relation, SingleRelation } from '@spinajs/orm';

@Model('books')
export class Book extends ModelBase<Book> {
  @Primary() public Id: number;
  public Title?: string;
  @BelongsTo('Author') public Author: SingleRelation<Author>;
}

@Model('authors')
export class Author extends ModelBase<Author> {
  @Primary() public Id: number;
  public Name: string;
  @Hidden() public Password: string;
  @HasMany(Book) public Books: Relation<Book, Author>;
}

@BasePath('authors')
export class AuthorsController extends BaseController {
  @Get(':id')
  public async read(): Promise<Ok<Author>> {
    return new Ok(new Author());
  }
}
