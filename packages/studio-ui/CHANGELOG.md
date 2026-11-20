# @spinajs/studio-ui

## Unreleased

- New package `@spinajs/studio-ui`: the Spina Studio web app (Vite, React 19, ckit) that `@spinajs/studio` serves under `/_studio`. This entry is the scaffold: the typed API layer over `@spinajs/studio/contracts`, read through React Query, and the base path taken from the `spina-studio-base` meta. The package ships `dist/` only, is published to the coderush registry, and its scripts print a SKIP notice when ckit is not linked (`npm run link:ckit`).
