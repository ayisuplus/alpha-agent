# Native preview and browser repair

Approved scope: user "开始修复", following `docs/2026-10-01-browser-and-office-foundation-audit.md`.
Base: 255ef2dc0264efed1d73ded35f498f3dcc5a02d9. Existing feature branch; preserve prior dirty submodule and screenshot.

## Constraints

- Retain native OMP browser APIs, Chromium login profile and desktop takeover.
- Give every Alpha session owned pages; activate the actual Electron view for CDP input.
- Reject disabled controls and input during manual takeover. A dispatched click alone is not a business outcome; inspect page results.
- Office defaults to read-only original-document rendering with the installed LibreOffice engine. Never silently substitute PDF; expose an explicit static fallback when native rendering is unavailable.
- No engine downloads, downgrades, system settings or user-file changes. Workers use private profiles/copies and bounded timeouts.

## Task 1: Session-owned browser pages

Files: `desktop/browser-host.cjs`, new `desktop/browser-proxy.cjs`, `src/native/launch.ts`, browser panel, `test/native-browser-host.test.ts`, `test/native-launch.test.ts`.

Interface: generated CDP URL `/sessions/<id>`; private Chromium port behind local CDP proxy. Root `/json/list` serves workbench observation. Session endpoints expose only owned targets. Host activates native views before input and supports owned popup targets. Stable public port and existing READY/control contract stay intact.

1. Assert independent targets/config files, trusted effective clicks on multiple views, disabled rejection, popup ownership and takeover pause; run RED against existing host.
2. Implement minimal host/proxy and per-session launch config; run the same real Electron/OMP tests GREEN.
3. Verify screencast and teardown, then commit this task's scoped files.

## Task 2: Original Office engine

Owned by Office agent: `src/native/capabilities/office/office-view-worker.py`, `office-view.ts`, `test/native-office-view.test.ts`, isolated evidence.

Interface: openOfficeView(path) returns id/kind/parts/part/document dimensions/readOnly/comments/revisions; renderOfficeView returns PNG tile; selectOfficeView returns selection/formula/cellAddress; closeOfficeView destroys isolated child/profile. Dimensions use TWIPs; 15 TWIPs per CSS pixel at scale 1. Unsupported or hung engine must fail with a concrete reason within bounded time.

1. Test original hashes, real rendered content, sheet/formula/comment structures where supported and timeout/cleanup.
2. Implement only verified native engine functions; record per-format capability limits.

## Task 3: Workbench integration and distribution

Root owns session-bound server routes, NativeOfficePreview, NativeFiles integration and portable file manifest.

1. Test session/path isolation, close/expiry, native default and explicit PDF fallback.
2. Integrate native tiles, scrolling/zoom, sheet selection and available comments/revisions with existing warm UI surfaces.
3. Include new runtime assets in portable build; verify `bun run check`, `bun run build:desktop-ui`, `bun run test`, portable build/probes as required by AGENTS.md.
4. Fresh whole-change review, repair significant findings with regression tests, scoped commits and evidence-backed delivery.

## Review focus

Cross-session target attachment/events/popups; overlapping input streams; frontend request races; worker failure and timeout; source immutability; unbounded profiles/processes; explicit preview limitations; portable path resolution.

## Progress

- Audit provides baseline RED evidence: hidden view clicks 0, same target reused by two processes, disabled click reports success, PDF omits structural content.
- Task 1 and Task 2 run independently; Task 3 consumes both interfaces.
