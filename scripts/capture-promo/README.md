# Hive introduction screenshots

The introduction tour shows 12 real Hive screenshots: six scenes (Welcome, Map, People, Inbox, Needs you, Delivery) in dark and light. They come from the real Hive UI running in a disposable Agent Wrangler instance seeded with a fictional "Launch a field guide" hive. Nothing is painted onto the page.

`public/promo/manifest.json` records how the current images were made: Hive and core commit SHAs, a digest of uncommitted source, the `bd` and browser versions, the isolation facts and a SHA-256 for each image.

## Recapture

Requires a checkout of Agent Wrangler core, `node` 24+, `tmux`, `bd` and Chrome. Repository policy keeps browsers out of ordinary agent runs, so run this only where a headless browser is permitted.

```sh
node scripts/capture-promo.mjs --core <agent-wrangler checkout> --port 65384 \
  --install-to public/promo [--chrome <path>] [--out <dir>] [--keep-server]
```

The script:

1. Creates a temporary data directory with its own `HOME` and starts core there.
2. Stages this checkout as the `hive` extension and adds a capture-only seeding handler to the temporary copy. The repository files are not modified.
3. Seeds the fixture sessions and runs the real Hive tools: adopt the hive, create beads, claim, review, request a decision and send conversation messages.
4. Drives headless Chrome to each scene, asserts the expected text, theme and visibility, then writes each PNG, `manifest.json` and, with `--install-to`, copies them into `public/promo/`.

`--keep-server` leaves the instance running for manual review; stop it with the printed `kill` command and delete its data directory. Without it, the script cleans up. A failed run always stops its server.

## Serve the final assets without recapturing

```sh
node scripts/capture-promo.mjs --core <agent-wrangler checkout> --port 65384 --serve-fixture
```

Stages the current checkout, including the installed `public/promo/` images, seeds the same fixture state through the real Hive tools and keeps the instance running without launching any browser. It prints the board and deck ports (pass them to `qa.mjs --deck-port`) and the stop command. Use it for QA and review against the final assets. A normal `--keep-server` capture also refreshes the demo's copy of the images after installing them.

## Isolation

- Core listens on loopback only; the script refuses port 7777. Browser capture is approved only for `http://localhost:65384` unless `--approved-origin` is passed deliberately.
- Chrome uses a throwaway profile, background networking off, and a request allowlist: only the instance's own origin and deck port load. External fonts and CDN requests are blocked and counted in the manifest.
- Core runs under an inert guard (`inert.mjs`) with a minimal environment: no provider API keys, no CLI-agent homes, temporary `HOME` and git config, no tokens. The guard's `PATH` blocks `claude`, `codex`, `gemini`, `gh` and similar commands. A `tmux` wrapper forces every call onto one capture-only socket and refuses anything that creates or drives panes. Sessions in the fixture are inert, so Inspect, Resume and Recreate cannot start an agent.
- Verify the guard without a browser: `node scripts/capture-promo.mjs --core <checkout> --check-guard`. It starts core on a random port, tries resume and dispatch, prints the guard's log and exits.

## Introduction QA

With an instance running (use `--keep-server`):

```sh
node scripts/capture-promo/qa.mjs --url http://localhost:65384/ --out <dir> --deck-port <ports>
```

It exercises the real intro at 1366×768, 1280×720, 1024×650, 390×844 and 320×640 in both themes and exits non-zero on any failure. It checks:

- Hexagon geometry, measured from rendered pixels, or the narrow-screen fallback.
- Page order and the real PNG shown on each page.
- Caption, footer and Close placement.
- Next, Back, jump and stop navigation.
- Escape, persistence of dismissal and replay from About Hive.

`--deck-port` takes the instance's comma-separated listening ports from `lsof -a -p <pid> -iTCP -sTCP:LISTEN`.
