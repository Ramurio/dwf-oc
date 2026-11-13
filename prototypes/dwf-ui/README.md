# DWF UI — Lines

Interactive, automatically laid-out workflow prototype. The selected Lines architecture originated in the Astra DWF experiment. The final paired-arrow, session-trace and call-count changes were developed with the user and approved for merging on 2026-11-13.

## Open locally

From the repository root, start a local HTTP server for the ES modules.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory prototypes/dwf-ui
```

Open <http://127.0.0.1:8000/>. Choose a run, select a primitive or participant, and inspect its calls, task, result, model settings, skills and copyable session command. Direct example links use `?run=research`, `?run=build`, `?run=ensemble` or `?run=large`.

Actual opposing transitions share two close routes. Green arrows show forward control, purple arrows show results or requested changes. Blocks show call counts and graphical session continuity. Click a block for the session explanation. Fit reveals the complete map. The percentage button restores 100% for reading, and scroll/drag navigates larger maps. Runs collapse into a menu on narrow screens.

All runs and OpenCode IDs in this **static demo** are fictional. The same `index.html`, `app.mjs`, `layout.mjs` and `styles.css` are shared with the persistent real-data service: run `dwf ui --start` (or `node dwf.mjs ui --start` from the repository). The service sets live mode and never serves demo fixtures. See [live UI documentation](../../docs/ui.md) for scope, lifecycle, session commands and checks. `baseline.html` preserves the earlier comparison snapshot.

## Reproduce checks

Requires Node with built-in WebSocket and local Google Chrome. Set `CHROME_BIN` for a different Chrome installation. Browser checks own disposable profiles and debugging ports. Evidence is saved under ignored `.evidence/` directories.

```sh
npm run test:ui # includes isolated real DWF/OpenCode + browser verification
node --test prototypes/dwf-ui/qa/layout.test.mjs
node prototypes/dwf-ui/qa/paired-routes.test.mjs
node prototypes/dwf-ui/qa/browser-checks.mjs
node prototypes/dwf-ui/qa/review-regressions.mjs
# With the local server above running
node prototypes/dwf-ui/qa/browser-paired.mjs http://127.0.0.1:8000/ prototypes/dwf-ui/.evidence/paired
```

The browser console exposes `dwfDemo.getGraph()`, `dwfDemo.showGraph(graph)` and `dwfDemo.getLayout()` for coordinate-free graph changes. `setParticipantState(id, state)` changes the demo observation with stable geometry. See [design.md](design.md) for routing and supported graph structures, and [CHECKS.md](CHECKS.md) for verification and limits.
