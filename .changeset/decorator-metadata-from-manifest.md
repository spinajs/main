---
"@spinajs/http": minor
"@spinajs/http-socket": minor
"@spinajs/di": minor
"@spinajs/configuration": minor
---

Apps that boot from a manifest no longer need `emitDecoratorMetadata`. `@spinajs/http` and `@spinajs/http-socket` fill a missing argument or `@Payload` type from the manifest (`TypeRef.ref`) before routes and handlers register, so validation and hydration behave as with metadata; in `require` an argument the manifest cannot type fails the boot. `@spinajs/di` records an `@Autoinject()` / `@LazyInject()` property without a type as pending and types it at resolve time through the `PROPERTY_TYPE_RESOLVER` value, which `@spinajs/configuration` registers with the manifest decision. A pending property that nothing can type now throws `ResolveException` naming the class and the property when the owner is resolved, instead of an error when the class is defined.
