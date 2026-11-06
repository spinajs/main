import { BelongsTo, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';

@Model('authors')
export class Author extends ModelBase<Author> {
  @Primary() public Id: number;
  public Name: string;
}

@Model('notes')
export class Note extends ModelBase<Note> {
  @Primary() public Id: number;
  @BelongsTo('Author') public Author: SingleRelation<Author>;
}

export async function strictRead(): Promise<string[]> {
  const notes = await Note.all();
  return notes.map((n) => n.Author.Value?.Name ?? '');
}

export async function strictAwait(ids: number[]): Promise<Note[]> {
  const out: Note[] = [];
  for (const id of ids) out.push(await Note.get(id));
  return out;
}
