import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { BelongsTo, HasMany, Hidden, Model, ModelBase, ModelDataWithRelationData, Primary, Relation, SingleRelation } from '@spinajs/orm';
import { Shelf } from './shelf.js';

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

@Model('local_shelves')
export class LocalShelf extends Shelf {
  public Label: string;
}

@BasePath('authors')
export class AuthorsController extends BaseController {
  @Get(':id')
  public async read(): Promise<Ok<Author>> {
    return new Ok(new Author());
  }

  @Get('dehydrated')
  public async dehydrated(): Promise<Ok<ModelDataWithRelationData<Author>[]>> {
    return new Ok([new Author().dehydrateWithRelations()]);
  }

  @Get('shelf')
  public async shelf(): Promise<Ok<Shelf>> {
    return new Ok(undefined as unknown as Shelf);
  }

  @Get('local-shelf')
  public async localShelf(): Promise<Ok<LocalShelf>> {
    return new Ok(new LocalShelf());
  }
}
