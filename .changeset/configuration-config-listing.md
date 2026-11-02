---
"@spinajs/configuration": minor
---

The file sources and `ManifestConfigurationSource` list the app's own config dirs with one `readdir` per directory instead of `glob`, and match a manifest package's `configFiles` without `minimatch`: the same files in the same order, including glob's handling of dot files, links (a linked directory is listed one level deep) and its `localeCompare` order. `glob` and `minimatch` are loaded only for what this listing does not cover: the `node_modules/@spinajs/*` dirs of the `off` mode, a fragment without `configFiles`, a directory with glob syntax in its path, or a file pattern other than `!(*.*).<ext>` and `*.<env>.<ext>`. A boot from a manifest probes each package's install level once, and takes the real path of each config directory once instead of each config file.
