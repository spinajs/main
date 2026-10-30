---
"@spinajs/compiler": minor
"@spinajs/authz-http": patch
---

Fragments list what directory discovery loads. The compiler skips abstract classes in every section, and `analyzePackage({ declaredDirsOnly: true })` (set by the repo's fragment build) lists a controller, socket controller, schedule, command or migration of a package only when its file is under a `system.dirs.*` dir the package's own config declares; the rest is registered by importing the package. Published fragments shrink accordingly. `ExplainControllerSource` hands its controller over as a source-provided one (`<di>`), so `authz.http.explainRoute.enabled` works in `require` mode without a manifest entry.
