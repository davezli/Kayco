# Trounce Domain Recommender — Service Spec

A spec to re-implement this service from scratch. It describes **what the service
does and the contracts it must honor**, not the current code. An implementer may
choose any stack that satisfies §9 (Non-goals / constraints).

---

## 1. Purpose

Genshin Impact characters level their three combat talents (Normal Attack, Elemental
Skill, Elemental Burst) using, among other things, *weekly-boss talent materials*
("trounce domain" drops). Each character is tied to exactly one boss material. Players
want to know *which weekly bosses to farm, and how many times*, to cover the talent
upgrades they actually plan to do — accounting for materials they already own.

The service takes a player's account export, lets them pick which characters/talents to
invest in, and produces a *ranked list of weekly bosses to farm* with per-material
deficits and an estimated number of weekly clears.

It is a *single-page, client-only web app*. No backend, no account, no network calls
after initial asset load. All computation runs in the browser.

---

## 2. Domain rules (authoritative — verify against genshin-db when baking data)

- A *weekly-boss talent material* ("boss mat") is, in genshin-db terms, a 5★
  AVATAR_MATERIAL with **no dropDomainId** (ids fall in the 113000–113999 range).
  It first appears in a talent's *level-7* upgrade cost.
- *Boss-mat cost to raise ONE talent*, per level step (going from level-1 to
  the given level):

  | Target level step | Boss mats |
  |---|---|
  | ≤ 6 | 0 |
  | 7 | 1 |
  | 8 | 1 |
  | 9 | 2 |
  | 10 | 2 |

  So one talent 1→10 costs *6*; maxing Skill+Burst = *12*; all three = *18*.
- Each *character maps to exactly one boss material*, and each boss material belongs
  to exactly one *boss*. A boss may drop *multiple* distinct materials (players
  can't choose which drops, so they're pooled per boss for the "runs" estimate).
- *Boss → material* grouping and *region/domain* display names are reconstructed
  from material metadata + a curated lookup table (cosmetic; must degrade gracefully
  when unknown).
- A weekly boss clear yields a *variable* number of talent mats (default assumption
  *2.7* average; user-adjustable). "Runs needed" = ceil(deficit / dropsPerRun).
- Some characters/materials are *beta / preview* (version > current live version).
  These must be included in data but flaggable, and excluded from the random-sample
  generator.

---

## 3. Inputs

### 3.1 Baked game data (data/game.json)
A frozen slice produced at build time (see §7). The app fetches it at startup. Shape:

jsonc
{
  "generatedAt": "ISO-8601 string",
  "dataVersion": "6.0",              // live game version label
  "perTalentToMax": {"7":1,"8":1,"9":2,"10":2},
  "characters": [
    {
      "key": "HuTao",                // GOOD PascalCase key (see §5) — join key
      "name": "Hu Tao",
      "element": "Pyro",
      "rarity": 5,
      "weapon": "Polearm",
      "region": "Liyue",
      "version": "1.3",              // release version (string) or null
      "bossMat": "Shard of a Foul Legacy",  // material NAME (join key into materials)
      "boss": "Childe",              // boss NAME (join key into bosses)
      "talents": {"normal": "...", "skill": "...", "burst": "..."},  // cosmetic names
      "icon": "UI_AvatarIcon_Hutao"  // basename of assets/icons/<icon>.png
    }
  ],
  "materials": {                     // keyed by material NAME
    "Shard of a Foul Legacy": {
      "name": "Shard of a Foul Legacy",
      "rarity": 5,
      "icon": "UI_ItemIcon_113023",
      "boss": "Childe",
      "description": "first line only",
      "version": "1.1"
    }
  },
  "bosses": [
    {
      "name": "Childe",
      "region": "Liyue",
      "domain": "Enter the Golden House",
      "materials": ["Shard of a Foul Legacy"],  // material NAMEs dropped here
      "version": "1.1"
    }
  ]
}

Current scale: ~118 characters, ~14 bosses, ~40 materials, ~68 KB JSON, ~158 icons.
The app must not hardcode these counts.

### 3.2 User account export — GOOD format
[GOOD](https://frzyc.github.io/genshin-optimizer/#/doc) (Genshin Open Object
Description) is the interchange format exported by *Genshin Optimizer*, *Irminsul*,
and *Inventory Kamera*. Relevant fields:

jsonc
{
  "format": "GOOD",                  // REQUIRED — reject input if absent/≠"GOOD"
  "version": 3,
  "characters": [
    { "key": "HuTao", "level": 90, "constellation": 1, "ascension": 6,
      "talent": { "auto": 10, "skill": 8, "burst": 9 } }   // CURRENT talent levels
  ],
  "materials": { "ShardOfAFoulLegacy": 12 }  // GOODkey -> owned count. MAY be absent.
}

Key facts the implementation must handle:
- characters[].key matches game.json
characters[].key exactly (join on this).
- characters[].talent uses **auto** for Normal Attack (not normal).
- materials is a Record<GOODkey, number>. *It may be missing entirely* (some
  scanners omit it) — then all inventory is treated as *0* and the UI must warn.
- Material inventory is keyed by the *GOODkey of the material name* (§5), not the
  display name.

---

## 4. Core computation

Given: selected characters + per-character settings + current talent levels (from
export) + inventory.

1. *Per-talent boss cost*: cost(cur, target) = Σ perTalentToMax[lvl] for
   lvl in max(cur+1, 7) .. target. (0 if cur >= target or target < 7.)
2. *Per-character need*: sum cost(currentLevel, target) over each enabled talent
   scope (Normal / Skill / Burst). A character contributes its need to its single
   bossMat.
3. *Per-material required* = sum of contributions across all included characters.
4. *Per-material deficit* = max(0, required − owned).
5. *Per-boss aggregation*: sum required, owned, and deficit across the boss's
   materials. runs = ceil(bossDeficit / dropsPerRun). A boss is *relevant* if any
   of its materials has required > 0 (or a positive deficit).
6. *Ranking*: sort relevant bosses by *deficit desc*, tie-break **total required
   desc**. Bosses fully satisfied by inventory (deficit 0 but required > 0) are shown
   as "satisfied" but ranked below those with deficit.

Summary metrics: number of domains with deficit > 0, total materials owed (Σ deficit),
total weekly clears (Σ runs), and an estimated resin cost (runs × 60).

---

## 5. GOODkey derivation (must match Irminsul / GO exactly)

Convert a display name to its GOOD key: iterate characters; keep [A-Za-z0-9] only;
*uppercase the first alnum after any space*; a space sets the "capitalize next" flag;
*apostrophes, hyphens, and other punctuation are dropped* without affecting
capitalization. Examples: "Hu Tao"→"HuTao", "Raiden Shogun"→"RaidenShogun",
"Shard of a Foul Legacy"→"ShardOfAFoulLegacy", "Yae Miko"→"YaeMiko". This function
is used both when baking data (character keys) and at runtime (to map material display
names → inventory keys).

---

## 6. UI / UX

Three vertically stacked steps. Steps 2 and 3 are hidden until an export is parsed.

*Step 1 — Load your account*
- Large paste <textarea> for GOOD JSON, a "Load file…" file picker (.json), an
  *Analyze* button, and a *🎲 Random 30 (re-roll)* button that generates a fresh
  random valid GOOD export for demoing (see §6.1).
- Status line (aria-live) reports success (`Read N characters and inventory for M boss
  materials`) or, when the export has no materials, an explicit warning that inventory
  is treated as 0. On error, show a clear message (invalid JSON / not a GOOD export).

*Step 2 — Who to invest in*
- Characters that are *both owned (in export) and in game data*, grouped by boss,
  boss groups ordered as in game.json, characters sorted by name within a group.
- Per character: include checkbox (clicking the name also toggles), portrait, a live
  "needs N" / "done" / "off" badge, a *Target Lv* select (7–10), and three **talent
  pills** (NA / Skill / Burst). Each pill shows current → target, is checkable, and
  renders *disabled + "✓ done"* when the current level already meets the target.
- Bulk controls: Select all / Deselect all; a *Count* preset (Skill+Burst [default]
  vs. All 3 talents); a *Target all →* select applying a target to every character.
- Defaults for a newly-seen character: included = true, target = 10, scope =
  Skill+Burst (Normal off).

*Step 3 — What to farm*
- An *Avg mats / run* number input (default 2.7, min 0.5) that recomputes on change.
- A summary stat row (domains to run / materials owed / weekly clears / resin).
- Ranked *boss cards*: rank badge, region + boss name (+ beta preview tag when
  version > live), domain name, runs + "still owed" metrics; a row of *material chips*
  (icon, owned / required, "need X" or ✓); and *contributing-character chips* (icon,
  name, count, e.g. Skill 6→10, Burst 8→10) sorted by contribution desc.
- If everything is covered, show an "all accounted for" message instead of cards.

Interactions are fully reactive: any settings change re-renders Steps 2 and 3.

### 6.1 Random sample generator
Produce a valid GOOD object: N random non-beta characters, random level (10–90),
constellation (0–6), random talent levels (1–10 each), and random boss-material
inventory (0–14 each, ~30% left at 0). Must round-trip through the normal parse path.

### 6.2 Visual style
Region-themed accent color per boss card/group (Mondstadt/Liyue/Inazuma/Sumeru/
Fontaine/Natlan/Nod-Krai + unknown fallback), via CSS custom properties. Icons lazy-load
and hide gracefully on error. Dark, game-flavored aesthetic; responsive; accessible
(labels, aria-live status). Footer credits genshin-db + icon source, disclaims HoYoverse
affiliation, and shows the baked data version.

---

## 7. Build-time data pipeline (scripts/extract.js equivalent)

A Node script, run manually by a maintainer, that bakes data/game.json and vendors
icons. *Never runs in the browser or in CI-per-request.*

Steps:
1. Load [`genshin-db`](https://www.npmjs.com/package/genshin-db) (v5+). It's a CommonJS
   Node package with the whole game DB embedded — see §8.
2. For every character with talent cost data: find its boss mat from lvl7 costs
   (§2), derive the boss name from the material's sources strings (strip
   "Lv. 70+ " prefix and " Challenge Reward…" suffix), attach curated region/domain
   metadata from a lookup table (graceful fallback to the boss name / "Unknown").
3. Emit the game.json shape in §3.1. Sort characters by name; bosses by region then
   name.
4. *Vendor icons*: collect every character + material filename_icon, download each
   missing one to assets/icons/<icon>.png from a reliable asset host
   (Project Amber https://gi.yatta.moe/assets/UI/<icon>.png is known-complete;
   enka.network misses some newer icons). Skip already-downloaded files. Report
   fetched/cached/failed counts.

Output is committed to the repo so the deployed site is fully self-contained (offline-
capable, no CDN dependency at runtime).

---

## 8. Using genshin-db — build-time vs. runtime (important)

genshin-db is a *CommonJS Node package* (require, main: ./src/main.js) that
embeds the entire game database (src/min/data.min.json, decompressed with pako).
The npm install ships *no prebuilt browser bundle*.

- *Default (Case A — build time):* the pipeline in §7. genshin-db runs only in Node
  to bake a slim JSON. *Nothing from genshin-db reaches the browser.* Adding more
  fields/entities later (weapons, more bosses, newer patch) is a data-pipeline change
  only — the app stays a static site. This is the recommended mode.
- *Case B — live in the browser:* only if a feature needs to query arbitrary
  characters/weapons on the fly (not just the baked slice). Then genshin-db must be
  *bundled* (a bundler to resolve require + inline the ~1 MB+ data blob + pako).
  Cost: the full embedded DB ships to every visitor. Prefer Case A unless truly needed.

The implementer should assume *Case A* unless the product explicitly requires runtime
lookups.

---

## 9. Non-goals & constraints

- *No backend.* All parsing/computation is client-side. The GOOD export never leaves
  the browser (privacy is a stated feature).
- *No routing, no multi-page.* Single page; a framework's router/SSR is unnecessary.
- *No runtime dependency on external CDNs* — icons and data are vendored.
- Stack is the implementer's choice, but must stay *static-deployable* (e.g.
  Cloudflare Pages) with either no build step (vanilla) or a static-output build (e.g.
  Vite). Given the app is one page of DOM rendering, a component framework (React) and
  especially a routing framework (React Router / Remix) add cost without benefit —
  avoid unless a concrete future feature justifies them.
- Do *not* hardcode game content (character/boss lists, versions) in app logic —
  everything data-driven from game.json so a re-bake keeps the app current.

## 10. Deployment

Static hosting (Cloudflare Pages recommended). Publish only: index.html, the app
script, styles, data/game.json, assets/. Exclude node_modules/, the build
scripts, and package manifests. Long-cache immutable icons; short-cache game.json.
See DEPLOY_SPEC.md for the detailed deploy configuration.

---

## 11. Acceptance checks

1. Load a real GOOD export → Steps 2 & 3 appear; character count matches owned∩known.
2. A character with Skill 6, Burst 8, target 10, Skill+Burst scope contributes
   cost(6,10)+cost(8,10) = 6+2 = 8 to its boss mat.
3. Owning ≥ required for a boss's mats → that boss shows "satisfied", ranked below any
   deficit boss; "runs" = 0.
4. Export *without* materials → warning shown, all inventory treated as 0, deficits
   equal requirements.
5. Boss ranking is by deficit desc, then required desc.
6. dropsPerRun change recomputes runs = ceil(deficit / dropsPerRun) without a
   reparse.
7. Random-30 button yields a parseable export every click and never includes beta chars.
8. Invalid JSON / non-GOOD input → clear error, no crash.
9. Missing icon → element hidden, layout intact.
10. Re-baking game.json for a new game version updates characters/bosses with no app
    code change.