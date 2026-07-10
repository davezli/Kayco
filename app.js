/**
 * Trounce Domain Recommender — main client app
 * Single-page, client-only. Loads data/game.json, parses a GOOD export,
 * and ranks weekly bosses to farm.
 */

'use strict';

/* ============================================================
 * GOOD key derivation (must match Irminsul / GO exactly)
 * ============================================================ */
function nameToGoodKey(name) {
  let result = '';
  let capitalizeNext = true;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (/[A-Za-z0-9]/.test(ch)) {
      result += capitalizeNext ? ch.toUpperCase() : ch.toLowerCase();
      capitalizeNext = false;
    } else if (/\s/.test(ch)) {
      // Only whitespace sets the capitalize flag; apostrophes/hyphens/
      // punctuation are dropped without affecting capitalization
      // (e.g. "Dvalin's Plume" -> "DvalinsPlume")
      capitalizeNext = true;
    }
  }
  return result;
}

/* ============================================================
 * GOOD parser
 * ============================================================ */
function parseGOOD(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
  if (!data || data.format !== 'GOOD') {
    throw new Error('Not a GOOD export (missing or wrong "format" field)');
  }
  const characters = (data.characters || []).map(ch => ({
    key: ch.key,
    level: ch.level,
    constellation: ch.constellation,
    ascension: ch.ascension,
    talent: ch.talent || {}
  }));
  const materialCounts = {};
  if (data.materials) {
    for (const [k, v] of Object.entries(data.materials)) {
      materialCounts[k] = v;
    }
  }
  return { characters, materialCounts, hasMaterials: !!data.materials };
}

/* ============================================================
 * State
 * ============================================================ */
let GAME = null;                          // baked data/game.json
const charState = new Map();              // key -> { included, target, normal, skill, burst, current:{auto,skill,burst} }
let dropsPerRun = 2.7;
let allowConversion = false;              // Step-3 toggle; OFF keeps spec behavior
let parsed = null;                        // last parse result
let newestBossSet = new Set();            // top-3 bosses by release version (NEW badge)

/* ============================================================
 * Data loading
 * ============================================================ */
async function loadGame() {
  const res = await fetch('data/game.json');
  GAME = await res.json();
  document.getElementById('dataVersion').textContent = 'Baked data: v' + GAME.dataVersion;

  // Mark the 3 most recently released bosses (by version desc; nulls oldest).
  newestBossSet = new Set(
    [...GAME.bosses]
      .sort((a, b) =>
        (b.version == null ? -Infinity : parseFloat(b.version)) -
        (a.version == null ? -Infinity : parseFloat(a.version)))
      .slice(0, 3)
      .map(b => b.name)
  );
}

/* ============================================================
 * Core computation
 * ============================================================ */

// Cost to raise one talent from cur -> target (0 if cur>=target or target<7)
function talentCost(cur, target, perTalentToMax) {
  if (target < 7 || cur >= target) return 0;
  let sum = 0;
  for (let lvl = Math.max(cur + 1, 7); lvl <= target; lvl++) {
    sum += perTalentToMax[lvl] || 0;
  }
  return sum;
}

// Compute required / owned / deficit per material, then aggregate per boss.
function compute() {
  const { perTalentToMax } = GAME;
  const matRequired = {};   // materialName -> required
  const matOwned = {};      // materialName -> owned
  const matContrib = {};    // materialName -> [{charKey,name,count,detail}]

  for (const [matName, mat] of Object.entries(GAME.materials)) {
    matOwned[matName] = parsed.materialCounts[nameToGoodKey(matName)] || 0;
    matRequired[matName] = 0;
    matContrib[matName] = [];
  }

  // Accumulate requirements from selected characters (per-talent targets)
  const SCOPES = [
    { scope: 'normal', label: 'NA', curKey: 'auto' },
    { scope: 'skill', label: 'Skill', curKey: 'skill' },
    { scope: 'burst', label: 'Burst', curKey: 'burst' }
  ];
  for (const [key, st] of charState) {
    if (!st.included) continue;
    const char = GAME.characters.find(c => c.key === key);
    if (!char) continue;
    const cur = st.current;
    let need = 0;
    const parts = [];
    for (const { scope, label, curKey } of SCOPES) {
      const t = st[scope];
      if (!t.enabled) continue;
      const c = talentCost(cur[curKey] || 1, t.target, perTalentToMax);
      need += c;
      if (c) parts.push(`${label} ${cur[curKey] || 1}→${t.target}`);
    }

    if (need > 0) {
      matRequired[char.bossMat] += need;
      matContrib[char.bossMat].push({ charKey: key, name: char.name, count: need, detail: parts.join(', ') });
    }
  }

  // Per-boss aggregation
  const bosses = GAME.bosses.map(b => {
    let required = 0, owned = 0, deficit = 0, excess = 0;
    const mats = [];
    for (const matName of b.materials) {
      const req = matRequired[matName] || 0;
      const own = matOwned[matName] || 0;
      required += req; owned += own;
      deficit += Math.max(0, req - own);
      excess += Math.max(0, own - req);
      mats.push({ name: matName, required: req, owned: own, deficit: Math.max(0, req - own), icon: GAME.materials[matName].icon });
    }
    // With conversion, a boss's materials are interchangeable (1:1) at the cost
    // of 1 Dream Solvent each. Excess in one material covers deficits in another
    // of the same boss, so the farmable deficit is the pooled shortfall and the
    // number of conversions is the reallocated surplus.
    let bossDeficit, conversions = 0;
    if (allowConversion) {
      bossDeficit = Math.max(0, required - owned);
      conversions = Math.min(excess, deficit);
    } else {
      bossDeficit = deficit;
    }
    const runs = bossDeficit > 0 ? Math.ceil(bossDeficit / dropsPerRun) : 0;
    const contribs = [];
    for (const matName of b.materials) {
      for (const c of matContrib[matName]) contribs.push(c);
    }
    contribs.sort((a, b) => b.count - a.count);
    return { ...b, required, owned, deficit: bossDeficit, conversions, runs, mats, contribs };
  });

  // Rank: deficit desc, then required desc
  bosses.sort((a, b) => {
    if (b.deficit !== a.deficit) return b.deficit - a.deficit;
    return b.required - a.required;
  });

  return bosses;
}

/* ============================================================
 * UI: status
 * ============================================================ */
function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status-bar show ' + (type || '');
}

/* ============================================================
 * UI: Step 2 — character selection
 * ============================================================ */
function buildCharacterState() {
  charState.clear();
  const known = new Map(GAME.characters.map(c => [c.key, c]));

  for (const ch of parsed.characters) {
    const char = known.get(ch.key);
    if (!char) continue; // only owned ∩ known
    const cur = ch.talent || {};
    // Default per-talent target/scope come from the character's baked
    // defaultBuild (sourced from genshinRater's recommended build); fall back
    // to Skill+Burst → 10 if absent.
    const b = char.defaultBuild || {
      normal: { enabled: false, target: 10 },
      skill: { enabled: true, target: 10 },
      burst: { enabled: true, target: 10 }
    };
    charState.set(ch.key, {
      included: char.included !== false,
      normal: { ...b.normal },
      skill: { ...b.skill },
      burst: { ...b.burst },
      defaultBuild: b, // for the reset-to-default control
      current: { auto: cur.auto || 1, skill: cur.skill || 1, burst: cur.burst || 1 }
    });
  }
}

function renderStep2() {
  const container = document.getElementById('characterGroups');
  container.innerHTML = '';

  // Group characters by boss (preserve GAME.bosses order)
  for (const boss of GAME.bosses) {
    const chars = GAME.characters.filter(c => c.boss === boss.name && charState.has(c.key));
    if (chars.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'boss-group';
    group.style.setProperty('--group-accent', regionColorDark(boss.region));

    const header = document.createElement('div');
    header.className = 'boss-group-header';
    header.style.background = regionColorDark(boss.region);
    header.innerHTML = `<span>${boss.name}</span>` +
      (isBeta(boss.version) ? `<span class="badge-beta">BETA</span>` : '') +
      (isNewBoss(boss) ? `<span class="badge-new">NEW</span>` : '');
    group.appendChild(header);

    const list = document.createElement('div');
    list.className = 'character-list';

    for (const char of chars) {
      list.appendChild(renderCharRow(char));
    }
    group.appendChild(list);
    container.appendChild(group);
  }
}

function renderCharRow(char) {
  const st = charState.get(char.key);
  const row = document.createElement('div');
  row.className = 'char-row' + (st.included ? '' : ' off');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'char-check';
  cb.checked = st.included;
  cb.addEventListener('change', () => { st.included = cb.checked; refreshAll(); });

  const img = document.createElement('img');
  img.className = 'char-portrait';
  img.src = `assets/icons/${char.icon}.png`;
  img.alt = char.name;
  img.onerror = () => img.classList.add('error');

  const name = document.createElement('span');
  name.className = 'char-name';
  name.textContent = char.name;

  const meta = document.createElement('div');
  meta.className = 'char-meta';
  const need = computeCharNeed(char.key);
  const badgeClass = !st.included ? 'off' : (need === 0 ? 'done' : 'need');
  const badgeText = !st.included ? 'off' : (need === 0 ? 'done' : `needs ${need}`);
  meta.innerHTML = `<span class="char-badge ${badgeClass}">${badgeText}</span>` +
    `<span>${char.element}</span><span>${char.weapon}</span>`;

  const controls = document.createElement('div');
  controls.className = 'char-controls';

  const pills = document.createElement('div');
  pills.className = 'talent-pills';
  pills.appendChild(makePill('normal', 'NA', char, st));
  pills.appendChild(makePill('skill', 'Skill', char, st));
  pills.appendChild(makePill('burst', 'Burst', char, st));

  const resetBtn = document.createElement('button');
  resetBtn.className = 'reset-btn';
  resetBtn.type = 'button';
  resetBtn.textContent = '↺';
  resetBtn.title = 'Reset to recommended build';
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetCharToDefault(st);
    refreshAll();
  });

  controls.appendChild(pills);
  controls.appendChild(resetBtn);

  row.appendChild(cb);
  row.appendChild(img);
  row.appendChild(name);
  row.appendChild(meta);
  row.appendChild(controls);

  // clicking the name toggles include
  name.addEventListener('click', () => { st.included = !st.included; cb.checked = st.included; refreshAll(); });
  row.addEventListener('click', (e) => {
    if (e.target === row || e.target === meta) { st.included = !st.included; cb.checked = st.included; refreshAll(); }
  });

  return row;
}

function resetCharToDefault(st) {
  if (!st.defaultBuild) return;
  for (const scope of ['normal', 'skill', 'burst']) {
    st[scope] = { ...st.defaultBuild[scope] };
  }
}

function makePill(scope, label, char, st) {
  const cur = st.current[scope === 'normal' ? 'auto' : scope] || 1;
  const t = st[scope];
  const pill = document.createElement('div');
  pill.className = 'pill';

  // Disabled talent: muted, no target selector; click to re-enable.
  if (!t.enabled) {
    pill.classList.add('off');
    pill.textContent = label;
    pill.title = 'Disabled — click to enable';
    pill.addEventListener('click', (e) => { e.stopPropagation(); t.enabled = true; refreshAll(); });
    return pill;
  }

  const done = cur >= t.target;
  if (done) pill.classList.add('done');
  else pill.classList.add('active');

  // Per-talent target selector (any level 1-10, always interactive even when
  // "done" so a finished-but-below-10 talent can still be pushed higher).
  const sel = document.createElement('select');
  sel.className = 'pill-target';
  for (let lv = 1; lv <= 10; lv++) {
    const o = document.createElement('option');
    o.value = lv; o.textContent = lv;
    if (lv === t.target) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', () => { t.target = parseInt(sel.value, 10); refreshAll(); });

  pill.appendChild(document.createTextNode((done ? '✓ ' : '') + `${label} ${cur}→`));
  pill.appendChild(sel);

  // Clicking the pill body disables the talent.
  pill.addEventListener('click', (e) => { e.stopPropagation(); t.enabled = false; refreshAll(); });
  return pill;
}

function computeCharNeed(key) {
  const st = charState.get(key);
  const cur = st.current;
  let need = 0;
  if (st.normal.enabled) need += talentCost(cur.auto || 1, st.normal.target, GAME.perTalentToMax);
  if (st.skill.enabled)  need += talentCost(cur.skill || 1, st.skill.target, GAME.perTalentToMax);
  if (st.burst.enabled)  need += talentCost(cur.burst || 1, st.burst.target, GAME.perTalentToMax);
  return need;
}

/* ============================================================
 * UI: Step 3 — farm results
 * ============================================================ */
function renderStep3() {
  const bosses = compute();
  const summary = document.getElementById('summary');
  const cards = document.getElementById('bossCards');
  const allDone = document.getElementById('allDone');

  const domainsWithDeficit = bosses.filter(b => b.deficit > 0).length;
  const totalOwed = bosses.reduce((s, b) => s + b.deficit, 0);
  const totalRuns = bosses.reduce((s, b) => s + b.runs, 0);
  const totalResin = totalRuns * 60;
  const totalSolvent = allowConversion
    ? bosses.reduce((s, b) => s + (b.conversions || 0), 0)
    : 0;
  // Dream Solvent you already own (from the GOOD export's materials map).
  const ownedSolvent = allowConversion
    ? (parsed.materialCounts[nameToGoodKey('Dream Solvent')] || 0)
    : 0;

  let solventCard = '';
  if (allowConversion) {
    const short = Math.max(0, totalSolvent - ownedSolvent);
    solventCard = `
    <div class="stat-card ${short > 0 ? 'stat-warn' : 'stat-ok'}">
      <div class="stat-value"><img class="stat-icon" src="assets/icons/UI_ItemIcon_113021.png" alt="Dream Solvent" onerror="this.style.display='none'"> ${totalSolvent}</div>
      <div class="stat-label">Dream Solvent · have ${ownedSolvent}${short > 0 ? ` · short ${short}` : ' · enough'}</div>
    </div>`;
  }

  summary.innerHTML = `
    <div class="stat-card"><div class="stat-value">${domainsWithDeficit}</div><div class="stat-label">Domains to run</div></div>
    <div class="stat-card"><div class="stat-value">${totalOwed}</div><div class="stat-label">Materials needed</div></div>
    <div class="stat-card"><div class="stat-value">${totalRuns}</div><div class="stat-label">Weekly clears</div></div>
    <div class="stat-card"><div class="stat-value">${totalResin}</div><div class="stat-label">Est. resin</div></div>
    ${solventCard}
  `;

  cards.innerHTML = '';
  // Show every boss with a real requirement, plus any newly-released trounce
  // domain (NEW badge) so players can see — and invest in — fresh content even
  // when no owned character yet needs its materials.
  const relevant = bosses.filter(b => b.required > 0 || isNewBoss(b));
  if (relevant.length === 0) {
    allDone.classList.remove('hidden');
    return;
  }
  allDone.classList.add('hidden');

  let rank = 1;
  for (const b of relevant) {
    cards.appendChild(renderBossCard(b, rank++));
  }
}

function renderBossCard(boss, rank) {
  const card = document.createElement('div');
  card.className = 'boss-card';
  const color = regionColor(boss.region);
  const rankColor = regionColorDark(boss.region);
  card.style.setProperty('--card-accent', color);

  const satisfied = boss.deficit === 0;
  const header = document.createElement('div');
  header.className = 'boss-card-header';
  header.innerHTML = `
    <span class="rank-badge" style="background:${rankColor}">${rank}</span>
    <div>
      <div class="boss-card-title">${boss.name} ${isBeta(boss.version) ? '<span class="badge-beta">BETA</span>' : ''} ${isNewBoss(boss) ? '<span class="badge-new">NEW</span>' : ''}</div>
      <div class="boss-card-sub">${boss.region} · ${boss.domain}</div>
    </div>`;

  const metrics = document.createElement('div');
  metrics.className = 'boss-metrics';
  metrics.innerHTML = `
    <div class="metric">Runs: <strong>${boss.runs}</strong></div>
    <div class="metric">Still needed: <strong>${boss.deficit}</strong></div>
    <div class="metric">Required: ${boss.required} · Owned: ${boss.owned}</div>` +
    (allowConversion && boss.conversions > 0
      ? `<div class="metric">Dream Solvent: <strong>${boss.conversions}</strong></div>`
      : '');

  const chips = document.createElement('div');
  chips.className = 'mat-chips';
  let chipCount = 0;
  for (const m of boss.mats) {
    if (m.required === 0 && m.owned === 0) continue;
    const chip = document.createElement('div');
    chip.className = 'mat-chip';
    // Only flag conversion when this boss actually has surplus material to
    // convert (otherwise it's misleading — no Dream Solvent is spent).
    const needTxt = (allowConversion && boss.conversions > 0)
      ? `<span class="convertible" title="Surplus from this boss converts 1:1 via Dream Solvent">↔ convertible</span>`
      : (m.deficit > 0 ? `<span class="need">need ${m.deficit}</span>` : `<span class="satisfied">✓</span>`);
    chip.innerHTML = `<img src="assets/icons/${m.icon}.png" alt="" onerror="this.style.display='none'"> ${m.name} <span class="owned">${m.owned}/${m.required}</span> ${needTxt}`;
    chips.appendChild(chip);
    chipCount++;
  }
  // New / satisfied domain with no materials in play yet — surface a hint.
  if (chipCount === 0 && boss.contribs.length === 0) {
    const note = document.createElement('div');
    note.className = 'mat-note';
    note.textContent = isNewBoss(boss)
      ? 'New domain — no characters selected for its materials yet.'
      : 'No materials needed at current selections.';
    chips.appendChild(note);
  }

  const contribs = document.createElement('div');
  contribs.className = 'contrib-chips';
  for (const c of boss.contribs) {
    const char = GAME.characters.find(x => x.key === c.charKey);
    const chip = document.createElement('div');
    chip.className = 'contrib-chip';
    chip.innerHTML = `<img src="assets/icons/${char.icon}.png" alt="" onerror="this.style.display='none'"> ${c.name} <span class="count">×${c.count}</span>`;
    chip.title = c.detail;
    contribs.appendChild(chip);
  }

  card.appendChild(header);
  card.appendChild(metrics);
  card.appendChild(chips);
  card.appendChild(contribs);
  return card;
}

/* ============================================================
 * Helpers
 * ============================================================ */
function regionColor(region) {
  const map = {
    Mondstadt: 'var(--region-mondstadt)',
    Liyue: 'var(--region-liyue)',
    Inazuma: 'var(--region-inazuma)',
    Sumeru: 'var(--region-sumeru)',
    Fontaine: 'var(--region-fontaine)',
    Natlan: 'var(--region-natlan)',
    'Nod-Krai': 'var(--region-nod-krai)',
    Snezhnaya: 'var(--region-snezhnaya)'
  };
  return map[region] || 'var(--region-unknown)';
}

// Same hue, darkened so white text on top stays readable (used for header /
// badge backgrounds; the bright --region-* color is kept for accent borders).
function regionColorDark(region) {
  return `color-mix(in srgb, ${regionColor(region)}, #000 35%)`;
}

function isBeta(version) {
  if (!version) return false;
  const v = parseFloat(version);
  return v > parseFloat(GAME.dataVersion || '0');
}

function isNewBoss(boss) {
  return newestBossSet.has(boss.name);
}

function refreshAll() {
  renderStep2();
  renderStep3();
}

/* ============================================================
 * Event handlers
 * ============================================================ */
function onAnalyze() {
  const text = document.getElementById('goodInput').value.trim();
  if (!text) { setStatus('Paste a GOOD export first.', 'error'); return; }
  try {
    parsed = parseGOOD(text);
  } catch (e) {
    setStatus('❌ ' + e.message, 'error');
    return;
  }
  afterParse();
}

function afterParse() {
  const knownKeys = new Set(GAME.characters.map(c => c.key));
  const ownedKnown = parsed.characters.filter(c => knownKeys.has(c.key)).length;
  const matKeys = Object.keys(parsed.materialCounts);
  let msg = `✅ Read ${parsed.characters.length} characters and inventory for ${matKeys.length} boss materials.`;
  let type = 'success';
  if (!parsed.hasMaterials) {
    msg = `⚠️ Read ${parsed.characters.length} characters, but NO materials field — inventory treated as 0.`;
    type = 'warning';
  }
  setStatus(`✅ ${msg} (${ownedKnown} owned ∩ known)`, type);

  buildCharacterState();
  document.getElementById('step2').classList.remove('hidden');
  document.getElementById('step3').classList.remove('hidden');
  refreshAll();
}

function onFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('goodInput').value = reader.result;
    onAnalyze();
  };
  reader.readAsText(file);
}

/* Random 30 sample generator (non-beta chars only) */
function randomGood() {
  const beta = new Set(GAME.bosses.filter(b => isBeta(b.version)).map(b => b.name));
  const candidates = GAME.characters.filter(c => !beta.has(c.boss));
  const pool = candidates.length >= 30 ? candidates : GAME.characters;
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 30);

  const characters = shuffled.map(c => {
    const r = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    return {
      key: c.key,
      level: r(20, 90),
      constellation: r(0, 6),
      ascension: r(0, 6),
      talent: { auto: r(1, 10), skill: r(1, 10), burst: r(1, 10) }
    };
  });

  const materials = {};
  for (const name of Object.keys(GAME.materials)) {
    const roll = Math.random();
    if (roll > 0.3) materials[nameToGoodKey(name)] = Math.floor(Math.random() * 15);
  }

  return { format: 'GOOD', version: 2, characters, materials };
}

function onRandom() {
  if (!GAME) return;
  const sample = randomGood();
  document.getElementById('goodInput').value = JSON.stringify(sample, null, 2);
  parsed = parseGOOD(JSON.stringify(sample));
  afterParse();
}

/* Bulk controls */
function applyToAll(fn) {
  for (const st of charState.values()) fn(st);
  refreshAll();
}

/* ============================================================
 * Init
 * ============================================================ */
async function init() {
  await loadGame();

  document.getElementById('analyzeBtn').addEventListener('click', onAnalyze);
  document.getElementById('fileInput').addEventListener('change', onFile);
  document.getElementById('randomBtn').addEventListener('click', onRandom);

  document.getElementById('dropsPerRun').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    dropsPerRun = isNaN(v) || v < 0.5 ? 0.5 : v;
    if (parsed) renderStep3();
  });

  document.getElementById('allowConversion').addEventListener('change', (e) => {
    allowConversion = e.target.checked;
    if (parsed) renderStep3();
  });
  // Browsers may restore a checked checkbox across a reload while the JS state
  // resets — sync from the DOM so the Dream Solvent card stays in step.
  allowConversion = document.getElementById('allowConversion').checked;

  document.getElementById('selectAllBtn').addEventListener('click', () => applyToAll(st => st.included = true));
  document.getElementById('deselectAllBtn').addEventListener('click', () => applyToAll(st => st.included = false));
  document.getElementById('resetAllBtn').addEventListener('click', () => applyToAll(st => resetCharToDefault(st)));

  document.getElementById('presetSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    applyToAll(st => {
      st.normal.enabled = (v === 'all3');
      st.skill.enabled = true;
      st.burst.enabled = true;
    });
  });

  document.getElementById('targetAllSelect').addEventListener('change', (e) => {
    const t = parseInt(e.target.value, 10);
    applyToAll(st => {
      st.normal.target = t;
      st.skill.target = t;
      st.burst.target = t;
    });
  });
}

init().catch(err => {
  console.error(err);
  setStatus('Failed to load game data: ' + err.message, 'error');
});
