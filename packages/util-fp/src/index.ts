import * as JSON from './json.js';
import * as FS from './fs.js';
import * as CONFIG from './config.js';
import * as LOG from './log.js';
import * as DI from './di.js';
export default { ...JSON.Util, ...FS.Util, ...CONFIG.Util, ...LOG.Util, ...DI.Util };
