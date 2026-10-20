# Sourced by pre-push: the local knowledge graph is rebuilt once per push, never per commit, merge
# or checkout. graphify-out/ is git-ignored; nothing is committed.
# Every rebuild also re-exports graphify-out/wiki, which no graphify rebuild regenerates.
# Run output is appended to <git-dir>/graphify-hook.log.
#   GRAPHIFY_SKIP_HOOK=1 git push ...   skip it, the same switch graphify's hooks honor
#   GRAPHIFY_BIN=/path/to/graphify      use a specific CLI binary

graphify_refresh() {
  [ "${GRAPHIFY_SKIP_HOOK:-0}" = "1" ] && return 0
  [ -f graphify-out/graph.json ] || return 0

  gfy_git_dir=$(cd "$(git rev-parse --git-dir)" && pwd)

  gfy_bin=${GRAPHIFY_BIN:-$(command -v graphify)}
  # GUI git clients often run hooks without ~/.local/bin on PATH.
  [ -z "$gfy_bin" ] && [ -x "$HOME/.local/bin/graphify.exe" ] && gfy_bin="$HOME/.local/bin/graphify.exe"
  [ -z "$gfy_bin" ] && return 0

  # Until communities are LLM-named the labels file is empty and the wiki falls back to
  # "Community N"; the heuristic names graphify keeps in the pending file are navigable.
  gfy_labels=graphify-out/.graphify_labels.json
  [ "$(wc -c < "$gfy_labels" 2>/dev/null || echo 0)" -gt 2 ] || gfy_labels=graphify-out/.graphify_labels.pending.json

  gfy_log="$gfy_git_dir/graphify-hook.log"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') $1 $(git rev-parse --short HEAD)" >> "$gfy_log"

  # Double fork with every stream redirected, so git returns without waiting for the run.
  ( {
      "$gfy_bin" update .
      # Article names follow community labels, so stale ones would linger without the wipe.
      rm -rf graphify-out/wiki
      "$gfy_bin" export wiki --labels "$gfy_labels"
    } < /dev/null >> "$gfy_log" 2>&1 & )
}
