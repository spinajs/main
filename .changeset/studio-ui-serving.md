---
"@spinajs/studio": minor
---

Spina Studio serves the prebuilt `@spinajs/studio-ui` (or the `dist/` that `studio.ui.path` names) under `studio.path`: `index.html` with a strict Content-Security-Policy and three injected elements (`<base href>`, the `spina-studio-base` meta with the served Studio path, and the `spina-app-base` meta with the global route prefix as a path, empty when none is set), hashed assets cached as `private, immutable`, and a client-side route fallback that never answers an API path. Without the UI package, the UI paths answer 404 with the install hint and the API keeps working. Docs: `docs/studio/`.
