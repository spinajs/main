import { registerTenantModel } from '../vendor/tenancy-orm/index.js';
import { Entry } from '../vendor/ledger-src/index.js';

registerTenantModel(Entry, { column: 'book_id' });
