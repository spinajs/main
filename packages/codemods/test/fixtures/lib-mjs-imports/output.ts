import x from '@spinajs/http';
// TODO(spinajs-4): "@spinajs/orm/lib/mjs/config/orm.js" is not an exported path in 4.x and "@spinajs/orm" does not re-export it; check the package exports
import '@spinajs/orm/lib/mjs/config/orm.js';
// TODO(spinajs-4): "@spinajs/di/lib/mjs/interfaces.js" is not an exported path in 4.x and "@spinajs/di" does not re-export it; check the package exports
import { y } from '@spinajs/di/lib/mjs/interfaces.js';
// TODO(spinajs-4): "@spinajs/log-common/lib/mjs/types.js" is not an exported path in 4.x and "@spinajs/log-common" does not re-export it; check the package exports
import type { Z } from '@spinajs/log-common/lib/mjs/types.js';
export * from '@spinajs/util';
// TODO(spinajs-4): "@spinajs/fs/lib/mjs/w.js" is not an exported path in 4.x and "@spinajs/fs" does not re-export it; check the package exports
export { w } from '@spinajs/fs/lib/mjs/w.js';
import local from './lib/mjs/local.js';
import other from 'other-pkg/lib/mjs/index.js';

const lazy = await import('@spinajs/queue');
// TODO(spinajs-4): "@spinajs/queue/lib/mjs/job.js" is not an exported path in 4.x and "@spinajs/queue" does not re-export it; check the package exports
const lazy2 = await import('@spinajs/queue/lib/mjs/job.js');
