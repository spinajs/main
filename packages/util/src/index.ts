import * as HASH from "./hash.js";
import * as ARRAY from "./array.js";
import * as JSON from './json.js';

export default { ...HASH.Util, ...ARRAY.Util, ...JSON.Util };
