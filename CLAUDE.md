# Trounce Domain Recommender

A **single-page, client-only** web app that reads a Genshin Impact GOOD account
export, lets the user pick characters/talents to invest in, and ranks the weekly
"trounce domain" bosses to farm — with per-material deficits and estimated clears.
Authoritative spec: `specs/system.md`.

## Architecture

Two halves, kept strictly separate (per spec §8):

- **Build-time pipeline** (`scripts/extract.js`) — runs in Node, bakes a slim
  `data/game.json` and vendors icons. Never runs in the browser.
- **Runtime app** (`index.html` + `app.js` + `styles.css`) — pure static
  frontend. No backend, no CDN. The GOOD export never leaves the browser.

```
index.html          # 3-step SPA shell (Load → Who to invest in → What to farm)
app.js              # parseGOOD, core compute(), reactive render, random-30
styles.css          # dark, region-themed boss cards
server.js           # tiny static dev server (node server.js → http://localhost:8080)
data/game.json      # baked output of extract.js (118 chars, 43 mats, 14 bosses)
assets/icons/       # vendored PNGs (UI_AvatarIcon_*, UI_ItemIcon_*)
scripts/extract.js  # build pipeline (genshin-db → game.json + icons)
src/goodkey.js      # nameToGoodKey() — shared, spec-critical
src/goodparser.js   # parseGOOD() — shared parser
samples/sample_good.json  # a real GOOD export kept as a test fixture
specs/system.md     # the service spec (source of truth for behavior)
```

## Common commands

```bash
node server.js                 # serve the app at http://localhost:8080
node scripts/extract.js        # re-bake data/game.json + re-vendor icons
```

`data/game.json` is committed (the site is fully self-contained / offline-capable).
Re-run `extract.js` when `genshin-db` publishes a new game version, then commit
the regenerated `game.json`.

## Critical invariants (easy to break)

**GOOD-key derivation** (`nameToGoodKey`, in `src/goodkey.js` + duplicated in
`app.js` + `scripts/extract.js`): must match Irminsul / Genshin Optimizer
exactly. Rules:
- Keep `[A-Za-z0-9]` only; **first** char is capitalized.
- **Only whitespace** sets the "capitalize-next" flag. Apostrophes, hyphens,
  and other punctuation are **dropped without affecting capitalization**
  (e.g. `"Dvalin's Plume"` → `DvalinsPlume`, `"Raiden Shogun"` → `RaidenShogun`).
  ⚠️ Do NOT capitalize after apostrophes — that was a real bug
  (`DvalinSPlume` ≠ `DvalinsPlume`, breaking inventory lookups).

**Beta flagging**: `isBeta(version)` = `parseFloat(version) > parseFloat(dataVersion)`.
`dataVersion` must reflect the live game version the baked data corresponds to.
⚠️ It was previously hardcoded `"6.0"`, falsely flagging released bosses
(The Doctor 6.3, Il Dottore 6.6) as BETA. It is now derived from `genshin-db`'s
advertised version (currently 6.7). If you re-bake from a newer `genshin-db`,
confirm `dataVersion` tracks it.

**Boss material detection** (in `extract.js`): a boss material is a 5★
`AVATAR_MATERIAL` with an id in `113000–113999`, first appearing at talent
level-7 cost. Each character maps to exactly one boss material → one boss.

## Core computation (`app.js` `compute()`)

- `talentCost(cur, target)` = Σ `perTalentToMax[lvl]` for `lvl` in
  `max(cur+1, 7)..target` (0 if `cur ≥ target` or `target < 7`).
  `perTalentToMax = {7:1, 8:1, 9:2, 10:2}` → 1→10 costs 6; Skill+Burst = 12.
- Per-character need = sum over enabled talents (Normal/Skill/Burst).
- Per-material required = sum across characters; deficit = `max(0, required−owned)`.
- Per-boss: aggregate, `runs = ceil(deficit / dropsPerRun)` (default 2.7).
- Rank relevant bosses by **deficit desc**, tie-break **required desc**;
  deficit-0 bosses shown as "satisfied", ranked below deficit bosses.

## Gotchas

- The three `nameToGoodKey` copies must stay in sync — change all three.
- `data/game.json` is the join hub: characters join on `key`, materials on
  `name`, inventory on `nameToGoodKey(materialName)`.
- Icons are referenced as `assets/icons/<icon>.png` where `<icon>` is the raw
  `filename_icon` (e.g. `UI_AvatarIcon_Hutao`). Missing icons hide gracefully.
- No unit tests yet; verify by loading `samples/sample_good.json` in the app.
