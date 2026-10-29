import { Injectable, AsyncService, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

export abstract class GenericAsync<T> extends AsyncService { public item: T; }
@Injectable()
export class StringAsync extends GenericAsync<string> {}

export abstract class GenericBoot<T> extends Bootstrapper { public item: T; }
@Injectable(Bootstrapper)
export class StringBoot extends GenericBoot<string> { public bootstrap(): void {} }

export abstract class GenericConfig<T> extends Configuration { public item: T; }
declare const generic: GenericConfig<string>;
generic.get('basic.generic');
