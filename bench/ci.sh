#!/usr/bin/env bash
# The CI test run: builds the packages and runs every bench test that checks
# behaviour. Each test exits non-zero on a failure, which stops the run.
#
#   npm test            release builds (minified)
#   npm run coverage    the same under c8, with unminified, source-mapped builds,
#                       and with the page already loaded when the bundle runs (--late)
#
# Also tools/fork-watch-test.py (Python; skipped without it, outside CI).
#
# Left out: the timing benches (hook-bench, panel-bench, module-hotpath-bench,
# emoji-amplify-test), which measure rather than pass or fail.
set -euo pipefail
cd "$(dirname "$0")/.."

B=dist/webOSUserScripts/userScript.js
env=()
for arg in "$@"; do
  case "$arg" in
    --coverage)
      env=(--env coverage)
      # Names the bundle the tests eval, so c8 can map it back to src/.
      export NODE_OPTIONS="${NODE_OPTIONS:-} --require ./bench/coverage-preload.cjs"
      ;;
    --late)
      # The page already loaded when the bundle runs, as on a TV
      # (bench/late-injection-preload.cjs).
      export NODE_OPTIONS="${NODE_OPTIONS:-} --require ./bench/late-injection-preload.cjs"
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

build() { echo "=== build $*"; npx webpack --mode=production --stats errors-warnings "${env[@]}" "$@"; }
# The last line of each test; on a failure its FAIL lines too, with the line
# under each, so the CI log says which case failed.
run() {
  echo "--- $1"
  local out status=0
  out="$(node "bench/$1.cjs" "${@:2}" 2>&1)" || status=$?
  printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$out" | grep -A1 '^FAIL' || printf '%s\n' "$out" | tail -n 20
    return "$status"
  fi
}

# tools/fork-watch.py with GitHub's API faked. It needs Python 3: without it
# the test is skipped, except in CI, where that is a failure.
fork_watch() {
  echo "--- fork-watch-test"
  local py=""
  for candidate in python3 python; do
    # On Windows, "python3" can be a stub that only offers to install Python.
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
      py="$candidate"
      break
    fi
  done
  if [ -z "$py" ]; then
    if [ -n "${CI:-}" ]; then
      echo "FAIL no Python 3 for tools/fork-watch-test.py"
      return 1
    fi
    echo "skipped: no Python 3"
    return 0
  fi
  local out status=0
  out="$("$py" tools/fork-watch-test.py 2>&1)" || status=$?
  printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$out" | grep -A1 '^FAIL' || printf '%s\n' "$out" | tail -n 20
    return "$status"
  fi
}

fork_watch
build
run polyfill-conformance
run launch-test
run release-bump-test
run appinfo-test
run smoke "$B" legacy
run adblock-test "$B" legacy
run new-features-test "$B"
run dependency-test "$B"
run dislike-timing-test "$B" legacy
run module-behaviour-test "$B"
run panel-test "$B"
run per-account-test "$B"
run feed-features-test "$B"
run pivot-filters-test "$B"
run settings-reset-test "$B"
run upstream-fixes-test "$B"
run preview-handover-test "$B"
run dearrow-test "$B" legacy
run ai-label-test
run most-replayed-test
run speed-audio-offer-test
run speed-restore-test
run speed-legacy-decoder-test
run speed-core-test
run speed-engine-test
run speed-mse-test
run buffer-limit-test
run speed-legacy-install-test "$B"
run whats-new-test "$B"
run guide-fit-test "$B"
run keyboard-search-test "$B"
run ai-filter-test "$B" legacy
run emoji-loop-test "$B" 40
run force-codec-test "$B"
run screensaver-test "$B"
run quality-tag-test "$B"
run watch-time-test "$B"
run search-filter-test "$B"
run sponsorblock-labels-test "$B"
run low-memory-style-test "$B"
run review-fixes-test "$B"

# Coverage stops here: c8 reads the bundle on disk when it reports, so that
# must still be the build the tests ran (the modern build reuses the path).
if [ ${#env[@]} -eq 0 ]; then
  build --env modern
  run modern-smoke "$B"
  run appinfo-test
  run dearrow-test "$B" modern
  run ai-filter-test "$B" modern
  run quality-reload-test "$B"

  # perf_mon is a dev tool, not part of the app.
  build --env perf
  run perfmon-test "$B" legacy
fi

echo "=== all tests passed"
