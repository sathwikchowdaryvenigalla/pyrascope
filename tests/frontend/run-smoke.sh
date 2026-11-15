#!/usr/bin/env sh
# Render smoke test (no browser): bundles the components with esbuild (installed with Vite) and renders them with
# react-dom/server against the contract fixtures. Run from the project root after `npm install`.
set -e
npx esbuild tests/frontend/render-smoke.entry.jsx --bundle --platform=node --format=esm --jsx=automatic --loader:.js=jsx \
  --outfile=tests/frontend/.smoke.build.mjs --log-level=error \
  --banner:js="import {createRequire} from 'module'; const require = createRequire(import.meta.url);"
node tests/frontend/.smoke.build.mjs
