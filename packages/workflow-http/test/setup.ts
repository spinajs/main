import { DI } from '@spinajs/di';

// Loaded by .mocharc.json before every suite. Kept for 4.x; DI.setESMModuleSupport() is a deprecated no-op and the file goes away in 5.0.
DI.setESMModuleSupport();
