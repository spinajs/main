import { BaseController, BasePath, Body, Get, Ok, Post } from '@spinajs/http';
import { Hidden, Model, ModelBase, ModelData, Primary } from '@spinajs/orm';
import { Author } from './models.js';
import { Shelf } from './shelf.js';

export interface IAuthorView extends Author {
  Shown: boolean;
}

export interface IShelfView extends Shelf {
  Shown: boolean;
}

@Model('editors')
export class Editorial extends ModelBase<Editorial> {
  @Primary() public Id: number;
  @Hidden() public Token: string;
  public Shelf?: Partial<Shelf>;
}

@BasePath('mapped')
export class MappedController extends BaseController {
  @Get('a-partial')
  public async aPartial(): Promise<Ok<Partial<Author>>> {
    return new Ok({});
  }
  @Get('a-pick')
  public async aPick(): Promise<Ok<Pick<Author, 'Id' | 'Password'>>> {
    return new Ok({ Id: 1, Password: '' });
  }
  @Get('a-omit')
  public async aOmit(): Promise<Ok<Omit<Author, 'Name'>>> {
    return new Ok(new Author());
  }
  @Get('a-readonly')
  public async aReadonly(): Promise<Ok<Readonly<Author>>> {
    return new Ok(new Author());
  }
  @Get('a-required')
  public async aRequired(): Promise<Ok<Required<Author>>> {
    return new Ok(new Author() as Required<Author>);
  }
  @Get('a-data')
  public async aData(): Promise<Ok<Partial<ModelData<Author>>>> {
    return new Ok({});
  }
  @Get('a-array')
  public async aArray(): Promise<Ok<Partial<Author>[]>> {
    return new Ok([]);
  }
  @Get('a-view')
  public async aView(): Promise<Ok<IAuthorView>> {
    return new Ok(undefined as unknown as IAuthorView);
  }
  @Post('a-body')
  public async aBody(@Body() body: Partial<Author>): Promise<Ok<Editorial>> {
    void body;
    return new Ok(new Editorial());
  }

  @Get('s-partial')
  public async sPartial(): Promise<Ok<Partial<Shelf>>> {
    return new Ok({});
  }
  @Get('s-pick')
  public async sPick(): Promise<Ok<Pick<Shelf, 'Id' | 'Password'>>> {
    return new Ok({ Id: 1, Password: '' });
  }
  @Get('s-omit')
  public async sOmit(): Promise<Ok<Omit<Shelf, 'Id'>>> {
    return new Ok(undefined as unknown as Omit<Shelf, 'Id'>);
  }
  @Get('s-readonly')
  public async sReadonly(): Promise<Ok<Readonly<Shelf>>> {
    return new Ok(undefined as unknown as Shelf);
  }
  @Get('s-required')
  public async sRequired(): Promise<Ok<Required<Shelf>>> {
    return new Ok(undefined as unknown as Required<Shelf>);
  }
  @Get('s-data')
  public async sData(): Promise<Ok<Partial<ModelData<Shelf>>>> {
    return new Ok({});
  }
  @Get('s-array')
  public async sArray(): Promise<Ok<Partial<Shelf>[]>> {
    return new Ok([]);
  }
  @Get('s-view')
  public async sView(): Promise<Ok<IShelfView>> {
    return new Ok(undefined as unknown as IShelfView);
  }
}
