---
"@spinajs/compiler": patch
---

Workflows follow `system.dirs.workflows` like the other scanned sections. In an application a `@Workflow` class outside those folders stays in the manifest with `mountedBy: 'di'` and the warning `CMP006`: the directory scan does not import it, so it runs only if something else does. A package's fragment lists a workflow only under a workflows folder its own config declares. `spinajs build` (without `--allow-no-dirs`) now counts workflows when it checks that the app's `system.dirs` were read: an application whose only scanned classes are workflows stops with `CMP007` when no `system.dirs` entry maps into it, and a `system.dirs.workflows` entry that maps into it now satisfies the check.
