# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SketchForge is a local-first, browser-based 3D CAD editor (TinkerCAD-style: primitives, solids/holes, grouping, booleans, chamfer/fillet, sketch extrude/revolve, STL/OBJ/SVG/STEP import/export). Next.js 15 + React 19 + TypeScript + Three.js, licensed AGPL-3.0-only. Shipped as a Next.js server (Docker), a static export, and an Electron desktop app.

## Commands

All commands run from the repo root (there is a single root `package.json`; the Next.js app lives in `apps/web`).

```bash
npm install
npm run dev                # next dev apps/web on http://127.0.0.1:3000 (predev stages occt wasm)
npm run typecheck          # tsc -p apps/web/tsconfig.json --noEmit
npm test                   # vitest unit tests: tests/unit/**/*.test.ts
npm run ci                 # typecheck + unit tests (what CI runs, Node 22)
npm run test:e2e           # tests/e2e/**/*.e2e.ts, 120s timeouts (OCCT kernel round trips)
npm run perf               # tests/perf, verbose reporter
npm run build              # production build (prebuild stages occt wasm)
npm run desktop:dev        # Electron shell around the dev server
npm run mcp:sketchforge    # stdio MCP bridge to a running dev editor tab
```

Single test file / single test:

```bash
npx vitest run --config tests/vitest.config.ts tests/unit/editorHistory.test.ts
npx vitest run --config tests/vitest.config.ts -t "name of test"
```

Tests run in the `node` environment (no DOM) and import app code through the `@` alias (`@` -> `apps/web/src`). Logic that needs testing therefore lives in `apps/web/src/lib/*` as pure functions, not inside components.

Caveat: `npm run export` uses Windows `set STATIC_EXPORT=true&&` syntax. On Linux/macOS run `STATIC_EXPORT=true npx next build apps/web && node scripts/verify-static-worker-assets.mjs` instead.

The PR template asks for `npm run typecheck` plus a manual test of the affected workflow. CONTRIBUTING asks to call out changes to storage, import/export, grouping, or undo/redo behavior.

## Architecture

### Layout

- `apps/web/src/app/page.tsx` – the whole client app entry: projects dashboard, IndexedDB/localStorage persistence, theme, update check, `.skf` import/export, and it mounts `SketchForgeEditor` for the open project. There is no client-side routing between dashboard and editor.
- `apps/web/src/components/SketchForgeEditor.tsx` (~10k lines) – editor state and all geometry operations: shape list, selection, undo/redo, grouping/hole subtraction/intersection (Manifold + three-bvh-csg), CAD edge treatments via worker, import/export, clipboard, MCP command handling.
- `apps/web/src/components/WorkplaneViewport.tsx` (~8k lines) – Three.js scene: rendering, camera (O toggles ortho/perspective), gizmos, snapping, outlines, live CSG previews.
- `apps/web/src/components/SketchWorkspace.tsx` – 2D sketch mode feeding extrude/revolve.
- `apps/web/src/components/workplane/*` – inspector, transform/dimension overlays, settings modal, tutorial panels.
- `apps/web/src/lib/*` – pure, unit-tested logic (one test file per module in `tests/unit/` with the same name).
- `apps/web/src/types/sketchforge.ts` – core domain types (`WorkplaneShape`, `ShapeKind`, `ProjectAsset`, workspace settings). Start here when adding a shape kind or property.
- `apps/web/src/app/api/*` – server routes (shared projects, thumbnails, app update, local download, MCP). They do not exist in the static export, so client code guards server features with `NEXT_PUBLIC_STATIC_EXPORT` (`STATIC_EXPORT_BUILD` constant).
- `apps/desktop/` – Electron main/preload (`window.sketchforgeDesktop` bridge, typed in `types/desktop.d.ts`); `build-web.mjs` builds the Next standalone output that Electron serves.
- `deploy/docker/` – Dockerfile, compose files, `start-server.mjs`. Docker builds set `SKETCHFORGE_DOCKER_BUILD=true` -> `output: "standalone"`.

### Geometry kernels (three of them, with different roles)

1. **Manifold (`manifold-3d`)** – mesh booleans for grouping/holes. Loaded from inlined sources in `apps/web/src/generated/manifoldModuleSource.ts` / `manifoldWasmBase64.ts` (blob import), with a URL fallback. These are generated blobs with no generator script in the repo; do not edit or read them in full.
2. **three-bvh-csg** – fast CSG for viewport previews and some editor operations.
3. **OpenCascade (`occt-wasm`, also via `brepjs` for STEP)** – exact B-Rep work in Web Workers: `workers/cadModifier.worker.ts` (chamfer/fillet, edge topology, display edges) and `workers/sketchCad.worker.ts` (sketch -> solid). The runtime is loaded with `import(/* webpackIgnore: true */ "/occt/occt-wasm.js")` because Emscripten glue does not survive bundling. `scripts/copy-occt-wasm.mjs` copies it from `node_modules` to `apps/web/public/occt/` (gitignored) before dev/build. If CAD features fail with a missing `/occt/...` file, run `npm run copy:occt`.

### Coordinates

The scene is **Y-up**; STL/OBJ/STEP files and slicers are **Z-up**. Always convert through `lib/meshCoordinates.ts` (`zUpToSketchForge` / `sketchForgeToZUp`) instead of ad-hoc swaps. Units are millimetres.

### Persistence and project format

- Private projects autosave to browser storage: project index in localStorage, shape/history data in IndexedDB (opened in `page.tsx`). Nothing is uploaded except the optional Docker shared library.
- Undo/redo history (`lib/editorHistory.ts`) stores full `WorkplaneShape[]` snapshots with fingerprints and size estimates; large numeric arrays and resources are shared across entries by identity. Preserve that sharing when changing shape data (don't clone mesh arrays unnecessarily).
- `lib/projectShapePersistence.ts` hydrates/reconciles stored shapes and imported mesh caches.
- `.skf` = ZIP with `project.json` + hashed, deduplicated `assets/` (source files, derived meshes, B-Rep, images, display edges), including the full undo history. Spec: `docs/SKF_PROJECT_FORMAT.md`; implementation: `lib/skfProject.ts`. Format changes need version handling there and a spec update.
- Docker shared projects: `/api/shared-projects` writes `.skf` files to `SKETCHFORGE_SHARED_PROJECTS_DIR` with revision checks (no overwrite of newer server revisions); thumbnails in `.thumbnails/`.

### MCP bridge (dev only)

`scripts/sketchforge-mcp-server.mjs` (stdio MCP server) -> `/api/sketchforge-mcp` (in-memory command queue in `lib/sketchforgeMcpStore.ts`, protocol in `lib/sketchforgeMcpProtocol.ts`) <- long-polled by each open editor tab, which executes commands in `SketchForgeEditor`. The route returns 404 in production and rejects non-localhost/cross-origin requests. Adding an MCP tool means touching the script, the protocol types, and the editor's command handler. Agent usage docs: `docs/skills/sketchforge-mcp-skill/SKILL.md`.

## Conventions (from CONTRIBUTING)

- Keep changes focused; avoid unrelated refactors. Prefer existing patterns over new abstractions.
- Keep UI behavior local to the relevant component unless shared.
- Areas needing extra care: STL import/export, imported mesh transforms, grouping/hole subtraction/ungrouping, undo/redo, project persistence and dashboard thumbnails, gizmos/snapping/rotated-object dimensions.
- Release notes go in `docs/CHANGELOG.md`; the version lives in root `package.json` and is duplicated as a hardcoded `SKF_CREATED_WITH_VERSION` in `lib/skfProject.ts`; bump both together.
