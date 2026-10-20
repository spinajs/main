import 'mocha';
import { runBehaviour } from '@spinajs/authz-testing';

import { httpHarness } from './support/http-harness.js';

// B09.http needs the orm facet (authz-orm, L4); it runs here once L4 merges.
runBehaviour(['B02.http', 'B10.http', 'B17.http', 'B23.http', 'B25.http', 'B38.http', 'B41.http'], () => httpHarness(), { strict: true });
