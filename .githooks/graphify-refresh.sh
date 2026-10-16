# Sourced by post-commit, post-merge and post-checkout. graphify's own hooks
# (<git-common-dir>/hooks) skip linked worktrees, so a worktree rebuilds its versioned graph
# here. Every checkout then re-exports graphify-out/wiki, which no graphify rebuild regenerates.
# Run output is appended to <git-dir>/graphify-hook.log.
#   GRAPHIFY_SKIP_HOOK=1 git commit ...   skip it, the same switch graphify's hooks honor
#   GRAPHIFY_BIN=/path/to/graphify        use a specific CLI binary

graphify_refresh() {
  [ "${GRAPHIFY_SKIP_HOOK:-0}" = "1" ] && return 0
  [ -f graphify-out/graph.json ] || return 0

  gfy_git_dir=$(cd "$(git rev-parse --git-dir)" && pwd)
  gfy_common_dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)
  [ -d "$gfy_git_dir/rebase-merge" ] && return 0
  [ -d "$gfy_git_dir/rebase-apply" ] && return 0
  [ -f "$gfy_git_dir/MERGE_HEAD" ] && return 0
  [ -f "$gfy_git_dir/CHERRY_PICK_HEAD" ] && return 0

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
      if [ "$gfy_git_dir" != "$gfy_common_dir" ]; then
        "$gfy_bin" update .
      else
        # graphify's hook has just launched a detached rebuild; give it time to take its
        # lock, then wait for the lock file to go before exporting from the new graph.
        sleep 20
        while [ -f graphify-out/.rebuild.lock ]; do sleep 5; done
      fi
      # Article names follow community labels, so stale ones would linger without the wipe.
      rm -rf graphify-out/wiki
      "$gfy_bin" export wiki --labels "$gfy_labels"
    } < /dev/null >> "$gfy_log" 2>&1 & )
}
