---
"@spinajs/client": minor
---

`generateClientFiles({ models: true })` adds client models to `client.ts`: a `<Dto>Model<F, M>` type per DTO, a `<Controller>ModelClient<F, M>` per controller that converts something, `AppModelClient<F, M>`, `ModelOf` and `DtoName`, the `plans` and `routePlans` the runtime walks, and a `createAppClient` overload that takes `formats` and `models`. With neither, `createAppClient` still returns `AppClient`, and without `models` the generated `client.ts` is unchanged. `format: 'date-time'`, `'date'` and `'decimal'` map to their format slots and `x-spinajs-type: 'bigint'` to `int64`. A union converts through its `x-discriminator`, or through a literal property that every member but one closed member declares (`UserDto | ValidationProblem` by `kind`), and otherwise keeps its wire type and converts nothing. The runtime's union plan gains `discriminator.absent`, the member chosen for a value without the property. `GENERATOR_TARGETS.models` is now available.
