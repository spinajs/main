# Spina Studio UI

The prebuilt web app that `@spinajs/studio` serves under `/_studio`. Install it next to `@spinajs/studio` from the coderush registry:

```sh
# the coderush GitLab group endpoint forwards the public @spinajs/* packages to npmjs
npm config set @spinajs:registry https://gitlab.coderush.pl/api/v4/groups/<coderush-group-id>/-/packages/npm/
npm install @spinajs/studio-ui
```

Without registry access, set `studio.ui.path` to an unpacked `dist/` instead.

`@spinajs/studio` finds `dist/` through `import.meta.resolve('@spinajs/studio-ui/dist/index.html')`; `studio.ui.path` points at another built `dist/` instead. Pages hide what `GET /_studio/api/capabilities` does not allow. Explain and Relations keep the principal, permission and resource of a lookup in the page URL (browser history, server access log): share those links with that in mind.

Development: `npm run link:ckit` at the monorepo root (ckit checkout at `CKIT_PATH`), then `npm run dev -w @spinajs/studio-ui` against an app on `STUDIO_APP_ORIGIN` (default `http://localhost:3000`).
