import * as JSON from "./json.js";
import * as HASH from "./hash.js";
import * as ARRAY from "./array.js";

export default { ...JSON.Util, ...HASH.Util, ...ARRAY.Util };
