import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';

/** A `@History` declaration that cannot be tracked. */
export class HistoryConfigError extends InvalidArgument {}

/** A history entry that could not be recorded. */
export class HistoryWriteError extends InvalidOperation {}
