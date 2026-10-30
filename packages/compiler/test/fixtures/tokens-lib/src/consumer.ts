import { Inject, Injectable, token } from '@spinajs/di';
import * as nomap from '../dep/nomap.js';
import * as malformed from '../dep/malformed.js';
import * as missing from '../dep/missing.js';
import * as nonliteral from '../dep/nonliteral.js';
import * as embedded from '../dep/embedded.js';
import { TPL, CAT, MISSING_KEY } from '../dep/mapped.js';
import { Cache } from './classes.js';

declare function compute(): string;
const P = 'local';
export const LOCAL_TPL = token<object>(`${P}.tpl`);
export const LOCAL_CAT = token<object>(P + '.cat');
export const LOCAL_DYNAMIC = token<object>(compute());

@Injectable()
@Inject(nomap.Cache as never, malformed.Cache as never, missing.Cache as never, nonliteral.Cache as never)
export class Unreadable {}

@Injectable()
@Inject(TPL as never, CAT as never, embedded.Cache as never, LOCAL_TPL as never, LOCAL_CAT as never, LOCAL_DYNAMIC as never)
export class Readable {}

@Injectable()
@Inject(MISSING_KEY as never)
export class NeedsMissing {}

@Injectable()
@Inject(Cache)
export class UsesCache {}
