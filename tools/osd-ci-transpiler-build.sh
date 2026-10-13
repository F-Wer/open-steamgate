#!/usr/bin/env bash
set -euo pipefail

# Absolute on CI ($RUNNER_TEMP/transpiler): actions/cache refuses a path with "..".
clone="${TRANSPILER:-../transpiler}"
case "${1:-}" in
  build|rebuild)
    if [[ "$1" == build ]]; then
      git clone --filter=blob:none "$OSD_TRANSPILER_REPO" "$clone"
      git -C "$clone" checkout "$OSD_TRANSPILER_REF"
    elif [[ "$(git -C "$clone" rev-parse HEAD)" != "$OSD_TRANSPILER_REF" ]] \
        || [[ -n "$(git -C "$clone" status --porcelain --untracked-files=no)" ]]; then
      echo "Pinned transpiler rebuild requires a clean checkout at $OSD_TRANSPILER_REF: $clone" >&2
      exit 1
    fi
    core=$(node -p 'require("./package.json").devDependencies["@abaplint/core"]')
    for manifest in "$clone/package.json" "$clone/packages/transpiler/package.json" "$clone/packages/cli/package.json"; do
      node -e 'const p = require(process.argv[1]); const v = p.dependencies?.["@abaplint/core"] ?? p.devDependencies?.["@abaplint/core"]; if (v !== process.argv[2]) throw new Error("Pinned transpiler parser requirement differs from OSG: " + v)' "$(realpath "$manifest")" "$core"
    done
    # The root supplies @types/node; ignore its recursive install script.
    npm --prefix "$clone" install --ignore-scripts --no-audit --no-fund
    for package in runtime transpiler cli; do
      npm --prefix "$clone/packages/$package" install --no-audit --no-fund
    done
    for package in runtime transpiler cli; do
      npm --prefix "$clone/packages/$package" run compile
    done
    chmod +x "$clone/packages/cli/abap_transpile"
    ;;
  verify) ;;
  *) echo 'usage: bash tools/osd-ci-transpiler-build.sh <build|rebuild|verify>' >&2; exit 2 ;;
esac

if [[ ! -d "$clone/.git" ]] || [[ "$(git -C "$clone" rev-parse HEAD)" != "$OSD_TRANSPILER_REF" ]]; then
  echo "::error::Pinned transpiler checkout is missing or at the wrong commit: $clone" >&2
  exit 1
fi
if ! grep -Fq 'this.options?.only?.(obj) === false' "$clone/packages/transpiler/build/src/index.js" \
    || ! grep -q 'only?:' "$clone/packages/transpiler/build/src/types.d.ts" \
    || ! grep -Fq 'reg.getConfig().get()) === JSON.stringify(conf.get())' "$clone/packages/transpiler/build/src/validation.js" \
    || ! grep -Fq 'obj.setDirty()' "$clone/packages/transpiler/build/src/validation.js"; then
  echo "::error::Pinned transpiler build lacks only-option or registry-reuse support" >&2
  exit 1
fi
if [[ ! -d "$clone/node_modules" ]] || [[ ! -s "$clone/packages/transpiler/build/src/index.js" ]] || [[ ! -x "$clone/packages/cli/abap_transpile" ]]; then
  echo "::error::Pinned transpiler cache has missing dependencies, compiled entry point, or CLI executable" >&2
  exit 1
fi
for package in runtime transpiler cli; do
  if [[ ! -d "$clone/packages/$package/node_modules" ]] || [[ ! -d "$clone/packages/$package/build" ]] \
      || [[ -z "$(find "$clone/packages/$package/build" -type f -name '*.js' -print -quit)" ]]; then
    echo "::error::Pinned transpiler cache has no installed and compiled $package package" >&2
    exit 1
  fi
done

# Cached builds must resolve the same parser OSG's manifest pins.
node -e 'const path = require("node:path"); const expected = require("./package.json").devDependencies["@abaplint/core"]; for (const at of [".", "packages/transpiler", "packages/cli"]) { const resolved = require.resolve("@abaplint/core/package.json", {paths: [path.resolve(process.argv[1], at)]}); const actual = require(resolved).version; if (actual !== expected) throw new Error("Pinned transpiler parser differs from OSG: " + at + " " + actual + " != " + expected); }' "$clone"
