# TODO

- `Configuration.set()` and `merge()` skip schema validation, so a value set at runtime is never checked.
- `@spinajs/configuration-db-source` pushes db rows with `set()` (`bootstrap.ts` syncConfigOption and the watch poll) without validation.
- `load()` resets the config tree, so a reload drops the defaults the schemas applied and is not validated again.
- `IConfigEntryOptions.required` is stored for admin UIs only; the `@Config` getter does not enforce it.
