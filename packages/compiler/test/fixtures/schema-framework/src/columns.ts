import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { BelongsTo, Hidden, Model, ModelBase, Primary, Virtual } from '@spinajs/orm';
import { Author } from './models.js';

export abstract class Stamped<T> extends ModelBase<T> {
  public CreatedAt: Date;
}

@Model('notes')
export class Note extends Stamped<Note> {
  @Primary() public Id: number;
  @Hidden() public Secret: string;
  @Virtual() public Score: number;
  @BelongsTo('Author') public Writer: Author;
  protected cache: string;
  private _body: string;

  public get Body(): string {
    return this._body;
  }

  public set Body(value: string) {
    this._body = value;
  }

  public get Preview(): string {
    return this._body.slice(0, 10);
  }
}

@BasePath('notes')
export class NotesController extends BaseController {
  @Get(':id')
  public async read(): Promise<Ok<Note>> {
    return new Ok(new Note());
  }
}
