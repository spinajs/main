import type { DateTime } from 'luxon';

type D = (...a: unknown[]) => ParameterDecorator;
declare const Query: D, QueryField: D, Param: D, ParamField: D, Body: D, BodyField: D, RawBody: D, FromXml: D, Header: D, HeadersField: D, Cookie: D;
declare const File: D, Files: D, CsvFile: D, JsonFile: D, Form: D, FormField: D, PKey: D, Uuid: D, FromDI: D, Req: D, Res: D, Ip: D, UserAgent: D, FromModel: D, AsModel: D;
declare function Hydrator(h: unknown): ClassDecorator;
declare function BasePath(p: string): ClassDecorator;
declare function Get(p?: string): MethodDecorator;
declare function Post(p?: string): MethodDecorator;
declare class BaseController {}
declare class CustomHydrator {}
export enum ParameterType { FromQuery = 'FromQuery', FromParams = 'FromParams', FromHeader = 'FromHeader', FromBody = 'FromBody' }
export enum Color { Red = 'red', Blue = 'blue' }

export type ListQuery = { page?: number; perPage?: number };
export class ListQueryDto { public page?: number }
export class CreateUserDto { public email!: string }
@Hydrator(CustomHydrator)
export class Hydrated { public raw!: string }
export class PostModel { public id!: number }

@BasePath('wire')
export class WireController extends BaseController {
  @Get('query')
  public query(@Query() query: ListQuery, @Query() dto: ListQueryDto, @Query() page: number, @Query() verbose?: boolean, @Query() color?: Color, @Query() mode?: 'a' | 'b', @Query() mixed?: string | number, @Query() ids?: number[], @Query() at?: DateTime, @Query() h?: Hydrated): void {}

  @Get('fields')
  public fields(@QueryField() q: ListQuery, @ParamField() p: unknown, @HeadersField() h: unknown, @BodyField() b: CreateUserDto, @RawBody() raw: unknown, @FromXml() xml: unknown, @Form() form: unknown): void {}

  @Get('params/:id/:p')
  public params(@Param() id: number, @Param() p: ListQueryDto, @PKey() key: number, @Uuid(ParameterType.FromQuery) uuid: string): void {}

  @Get('headers')
  public headers(@Header('X-Tenant') tenant: string, @Header() token: string, @Header('x-json') json: ListQuery, @Cookie() session: string): void {}

  @Post('one')
  public one(@Body() body: CreateUserDto): void {}

  @Post('two')
  public two(@Body() a: CreateUserDto, @Body() b: CreateUserDto): void {}

  @Post('prim')
  public prim(@Body() email: string): void {}

  @Post('files')
  public files(@File() avatar: unknown, @Files() photos: unknown[], @CsvFile() csv: unknown, @JsonFile() json: unknown, @FormField() title: string, @FormField() tags: string[], @FormField() meta: ListQuery): void {}

  @Get('injected')
  public injected(@FromDI() svc: unknown, @Req() req: unknown, @Res() res: unknown, @Ip() ip: string, @UserAgent() ua: string): void {}

  @Get('models/:id')
  public models(@FromModel() id: PostModel, @FromModel({ paramType: ParameterType.FromQuery, paramField: 'postId' }) q: PostModel, @AsModel() body: PostModel): void {}

  @Post('as-models')
  public asModels(@AsModel('first') a: PostModel, @AsModel() b: PostModel, @AsModel('h', ParameterType.FromHeader) c: PostModel): void {}
}
