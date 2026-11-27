---
"@spinajs/compiler": patch
---

A model registered twice as an access resource (`@AccessResource`, `registerAccessResource`) with different options is the build error `AUTHZ012`, as `@spinajs/authz-orm` throws for it when the application starts. The same options in another order are one registration. Options the build cannot read in full (a variable it cannot follow to an object literal, a `let` or `var` read at any depth, a spread or a member it cannot read) are not compared and get a `CMP001` note, so options the build cannot read never give a false error. The build compares every registration in the package's source, also one in a branch or a function that does not run at start.
