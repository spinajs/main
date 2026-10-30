import { DI } from '@spinajs/di';
import { join } from 'path';

export const dir = join(process.cwd(), 'lib', 'config');
DI.register(Foo).as(Bar);
