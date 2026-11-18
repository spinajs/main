# Spina Studio UI

`@spinajs/studio-ui` is the web app of Spina Studio: a Vite + React 19 + ckit build that `@spinajs/studio` serves under `studio.path` (default `/_studio`). It ships only a built `dist/` and lives on the coderush GitLab registry (map the `@spinajs` scope to the GitLab group endpoint, which forwards the public packages to npmjs, or set `studio.ui.path` to an unpacked `dist/`).

- `GET /_studio/api/capabilities` decides which pages the sidebar and the command palette list: a feature the app does not expose, or a permission the caller does not hold, hides the page and explains why when opened by URL.
- Studio API calls go to `<studio.path>/api/*`; request statistics come from `@spinajs/telemetry` (`/telemetry/*`, needs `telemetry:read`) and scheduler runs from `@spinajs/scheduler-http` (`/scheduler/*`, needs `scheduler:read`).
- Explain and Relations deep links carry the principal, permission and resource in the URL.
- Building from source needs the ckit checkout linked (`npm run link:ckit`); the GitHub pipeline skips the package, the GitLab `studio-ui` job builds and tests it.
- Authentication is the app's session cookie and nothing else. Studio calls the API with same-origin `fetch` and follows live data with `EventSource`, which cannot send an `Authorization` header; an app that accepts bearer tokens only cannot open Studio.
- Requests to other packages (`/telemetry/*`, `/scheduler/*`) go under the app's route prefix (`http.controllers.route.prefix`), which the Studio server writes into the `spina-app-base` meta of the page (empty without a prefix, else a path like `/api`). The dev server (`npm run dev`) writes the same meta from `STUDIO_APP_PREFIX`: leave it unset for an app without a prefix, set `STUDIO_APP_PREFIX=/api` for one with `http.controllers.route.prefix: 'api'`.
- Lint and typecheck: `npm run lint -w @spinajs/studio-ui` and `npm run typecheck -w @spinajs/studio-ui`. The root lint skips the package, because its `@coderush/*` imports resolve only where ckit is linked; the package's own `eslint.config.mjs` lints it there.
