# TODO

- `@spinajs/configuration-db-source` pushes db rows with `set()` (`bootstrap.ts` syncConfigOption and the watch poll). `set()` validates them now, and both callers log a refused row; in the watch poll that row also stops the rows after it from being applied.
- `IConfigEntryOptions.required` is stored for admin UIs only; the `@Config` getter does not enforce it.
