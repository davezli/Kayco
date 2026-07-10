#!/usr/bin/env node
/**
 * Build-time data pipeline for Trounce Domain Recommender
 * Bakes data/game.json and vendors icons from genshin-db
 *
 * Run manually by maintainers, NOT in CI or browser
 */

const fs = require('fs');
const path = require('path');

// Try to load genshin-db
let genshinDb;
try {
  genshinDb = require('genshin-db');
} catch (e) {
  console.error('genshin-db not found. Install with: npm install genshin-db');
  process.exit(1);
}

const ICONS_DIR = path.join(__dirname, '..', 'assets', 'icons');
const GAME_JSON_PATH = path.join(__dirname, '..', 'data', 'game.json');
// Vendored copy of https://gitlab.com/nate12345678/genshinRater/-/raw/main/config.json
// (committed so the bake is reproducible/offline). Supplies per-character default
// builds via each char's `default.talentPriority` (recommended target level per
// talent: 0/2/6 = no boss mats, 8/10 = needs weekly-boss drops).
const RATER_CONFIG_PATH = path.join(__dirname, '..', 'data', 'genshinRaterConfig.json');

// Curated lookup table for region/domain display names
const BOSS_METADATA = {
  'Stormterror': { region: 'Mondstadt', domain: 'Confront Stormterror' },
  'Wolf of the North': { region: 'Mondstadt', domain: 'Wolf of the North Challenge' },
  'Childe': { region: 'Liyue', domain: 'Enter the Golden House' },
  'Azhdaha': { region: 'Liyue', domain: 'Beneath the Dragon-Queller' },
  'Lord of Eroded Primal Fire': { region: 'Liyue', domain: 'Crimson Witch of Embers' },
  'Signora': { region: 'Inazuma', domain: 'Narzissenkreuz' },
  'Guardian of Eternity': { region: 'Inazuma', domain: 'Musou Shrine' },
  'Shouki no Kami, the Prodigal': { region: 'Sumeru', domain: 'Joururi Workshop' },
  'Guardian of Apep\'s Oasis': { region: 'Sumeru', domain: 'Temple of Silence' },
  'All-Devouring Narwhal': { region: 'Fontaine', domain: 'Laments of the Fallen' },
  'The Knave': { region: 'Fontaine', domain: 'Knave\'s Laporte' },
  'Il Dottore': { region: 'Sumeru', domain: 'Binding Field of Universal Nirvana' },
  'The Doctor': { region: 'Nod-Krai', domain: 'False Moon Institute' },
  'The Game Before the Gate': { region: 'Natlan', domain: 'Simulanka' },
};

/**
 * Convert a display name to GOOD key format
 * Required to match Irminsul / Genshin Optimizer exactly
 */
function nameToGoodKey(name) {
  let result = '';
  let capitalizeNext = true;

  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (/[A-Za-z0-9]/.test(char)) {
      if (capitalizeNext) {
        result += char.toUpperCase();
      } else {
        result += char.toLowerCase();
      }
      capitalizeNext = false;
    } else if (/\s/.test(char)) {
      // Only whitespace sets the capitalize-next flag; apostrophes, hyphens,
      // and other punctuation are dropped WITHOUT affecting capitalization
      // (e.g. "Dvalin's Plume" -> "DvalinsPlume")
      capitalizeNext = true;
    }
  }

  return result;
}

// Default build used when a character has no genshinRater entry: all three
// talents on, target 10. Stored per-talent so the app can show/reset each
// talent independently.
const FALLBACK_BUILD = {
  normal: { enabled: true, target: 10 },
  skill: { enabled: true, target: 10 },
  burst: { enabled: true, target: 10 }
};

/**
 * Derive a per-character, per-talent default build from genshinRater's
 * `talentPriority`. Every talent is enabled on load (the UI shows curr→target
 * for all three) and the target is the *actual* recommended level (1-10),
 * unclamped — a level below 7 just means no weekly-boss materials are needed.
 * Returns null if no talentPriority.
 */
function deriveDefaultBuild(talentPriority) {
  if (!talentPriority) return null;
  const mk = (s) => {
    const lvl = Math.max(1, Math.min(10, Number(talentPriority[s] || 0)));
    return { enabled: true, target: lvl };
  };
  return { normal: mk('auto'), skill: mk('skill'), burst: mk('burst') };
}

/**
 * Pick the build to use as a character's default. Characters may have several
 * named builds (e.g. `default`, `vape`, reaction variants). Prefer the
 * *recommended* build — its `buildHelp` contains "(R)" — otherwise fall back to
 * the first build that has a `talentPriority`. Returns the build object or null.
 */
function selectRaterBuild(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const builds = Object.values(entry).filter((b) => b && b.talentPriority);
  if (builds.length === 0) return null;
  const rec = builds.find((b) => typeof b.buildHelp === 'string' && b.buildHelp.includes('(R)'));
  return rec || builds[0];
}

/**
 * Find the boss material for a character by looking at talent lvl7 costs
 * Returns the material name (e.g., "Shard of a Foul Legacy")
 */
function findBossMaterialForCharacter(charKey) {
  // Try to get talent data for this character
  const talent = genshinDb.talent(charKey);
  if (!talent || !talent.costs || !talent.costs.lvl7) return null;

  // Look for a 5-star AVATAR_MATERIAL in lvl7 costs
  // Boss materials have IDs in 113000-113999 range
  for (const cost of talent.costs.lvl7) {
    const materialId = cost.id;
    // Boss materials are 5-star avatar materials with IDs 113000-113999
    if (materialId >= 113000 && materialId <= 113999) {
      // Get material data to verify it's an AVATAR_MATERIAL
      const matData = genshinDb.material(cost.name);
      if (matData && matData.category === 'AVATAR_MATERIAL') {
        return cost.name;
      }
    }
  }

  return null;
}

/**
 * Derive boss name from material sources
 * Use whether the source contains " Challenge Reward" to identify boss materials
 */
function deriveBossFromMaterial(material) {
  if (!material || !material.sources || material.sources.length === 0) return null;

  for (const source of material.sources) {
    // Strip "Lv. 70+ " prefix and " Challenge Reward…" suffix
    // Boss materials are those with source text like "Lv. 70+ Childe Challenge Reward"
    // Note: We're verifying against the actual item name of the material
    let bossName = source.replace(/^Lv\. 70\+ /, '').replace(/ Challenge Reward.*$/, '');
    if (bossName && bossName !== source && bossName !== material.name) {
      return bossName;
    }
  }

  return null;
}

/**
 * Build-time guardrails for boss metadata. Throws to abort the bake (non-zero
 * exit) when data is incomplete or internally inconsistent, so mistakes can't
 * ship silently. Invariants:
 *   - Every boss must have a curated region + domain (an entry in BOSS_METADATA);
 *     'Unknown' means a newly-added boss we forgot to handle.
 *   - Trounce domains are 1:1 with bosses, so no two bosses may share a domain.
 */
function validateBosses(bosses) {
  const byDomain = new Map();
  for (const boss of bosses) {
    if (boss.region === 'Unknown') {
      throw new Error(`Bake aborted: boss "${boss.name}" has no curated region in BOSS_METADATA.`);
    }
    if (boss.domain === 'Unknown') {
      throw new Error(`Bake aborted: boss "${boss.name}" has no curated domain in BOSS_METADATA.`);
    }
    if (byDomain.has(boss.domain)) {
      throw new Error(
        `Bake aborted: trounce domain "${boss.domain}" is shared by ` +
        `"${byDomain.get(boss.domain)}" and "${boss.name}" — domains must be 1:1 with bosses.`
      );
    }
    byDomain.set(boss.domain, boss.name);
  }
}

/**
 * Main extraction function
 */
function extract() {
  const gdb = genshinDb;
  const all = require('genshin-db/src/min/data.min.json');

  // Load vendored genshinRater config for per-character default builds.
  let raterChars = {};
  try {
    raterChars = require(RATER_CONFIG_PATH).characters || {};
    console.log(`Loaded genshinRater config (${Object.keys(raterChars).length} characters)`);
  } catch (e) {
    console.warn('genshinRater config not found at', RATER_CONFIG_PATH,
      '- falling back to Skill+Burst defaults for all characters.');
  }

  console.log('Loading genshin-db...');

  // Data structures
  const characters = [];
  const materials = {};
  const bosses = {};
  const bossMaterials = new Set();

  // Get all character names from index
  const allChars = Object.values(all.index.English.characters.names);
  console.log(`Found ${allChars.length} characters`);

  for (const charKey of allChars) {
    // Get character data
    const char = genshinDb.character(charKey);
    if (!char) continue;

    const goodKey = nameToGoodKey(char.name || charKey);
    // Find boss material from talent costs
    let bossMat = null;
    let boss = null;

    // Try to get boss material from character's talents
    bossMat = findBossMaterialForCharacter(charKey);
    if (bossMat) {
      boss = deriveBossFromMaterial(genshinDb.material(bossMat));
    }

    if (!bossMat || !boss) continue;

    bossMaterials.add(bossMat);

    // Get weapon type name
    const weaponType = char.weaponType || char.weaponText;
    const weaponName = weaponType ? weaponType.replace('WEAPON_', '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null;

    // Format element name
    const elementRaw = char.elementType || char.elementText || null;
    const elementName = elementRaw ? elementRaw.replace('ELEMENT_', '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null;

    // Get talent names
    let talentNames = { normal: null, skill: null, burst: null };
    const talent = genshinDb.talent(charKey);
    if (talent) {
      talentNames = {
        normal: talent.combat1?.name || null,
        skill: talent.combat2?.name || null,
        burst: talent.combat3?.name || null
      };
    }

    characters.push({
      key: goodKey,
      name: char.name || charKey,
      element: elementName,
      rarity: char.rarity,
      weapon: weaponName,
      region: char.region || null,
      version: char.version || null,
      bossMat: bossMat,
      boss: boss,
      // Dummy/development characters (e.g. Manekin) are unchecked by default.
      included: /manekin/i.test(goodKey) ? false : undefined,
      talents: talentNames,
      icon: char.images?.filename_icon || null,
      defaultBuild: (() => {
        const entry = raterChars[goodKey];
        const selected = selectRaterBuild(entry);
        const built = selected && deriveDefaultBuild(selected.talentPriority);
        return built || FALLBACK_BUILD;
      })()
    });
  }

  // Sort characters by name
  characters.sort((a, b) => a.name.localeCompare(b.name));

  // Get materials - filter for 5-star AVATAR_MATERIAL with no dropDomainId
  // Use the index to get all material filenames
  const allMaterials = Object.values(all.index.English.materials.names);

  for (const matKey of allMaterials) {
    const item = genshinDb.material(matKey);
    if (!item || !item.rarity || item.rarity !== 5) continue;
    if (item.category !== 'AVATAR_MATERIAL') continue;

    // Boss materials have IDs 113000-113999
    if (item.id < 113000 || item.id > 113999) continue;

    // Check if it has no dropDomainId or not from a domain
    const boss = deriveBossFromMaterial(item);

    materials[item.name] = {
      name: item.name,
      rarity: item.rarity,
      icon: item.images?.filename_icon || item.name.replace(/\s+/g, ''),
      boss: boss,
      description: (item.description || '').split('\n')[0] || '',
      version: item.version || null
    };

    if (boss) {
      if (!bosses[boss]) {
        bosses[boss] = {
          name: boss,
          region: BOSS_METADATA[boss]?.region || 'Unknown',
          domain: BOSS_METADATA[boss]?.domain || 'Unknown',
          materials: [],
          version: item.version || null
        };
      }
      bosses[boss].materials.push(item.name);
    }
  }

  // Sort materials by name
  const sortedMaterials = {};
  Object.keys(materials).sort().forEach(name => {
    sortedMaterials[name] = materials[name];
  });

  // Convert bosses to array and sort by region then name
  const bossesList = Object.values(bosses).sort((a, b) => {
    const regionCompare = (a.region || '').localeCompare(b.region || '');
    if (regionCompare !== 0) return regionCompare;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Sort materials within each boss
  for (const boss of bossesList) {
    boss.materials.sort();
  }

  // Guardrails: fail the bake (non-zero exit) on incomplete/inconsistent boss
  // metadata so bad data can't ship silently.
  validateBosses(bossesList);

  // Build game.json
  // dataVersion = the live game version this baked data corresponds to.
  // Derive it from genshin-db (its package description advertises the game
  // version it covers) so the isBeta() check is correct. Hardcoding here is
  // what falsely flagged released bosses (e.g. The Doctor 6.3, Il Dottore 6.6)
  // as BETA when dataVersion lagged behind the data.
  const genshinDbPkg = require('genshin-db/package.json');
  const dataVersionMatch = (genshinDbPkg.description || '').match(/v?(\d+\.\d+)/);
  const dataVersion = dataVersionMatch ? dataVersionMatch[1] : '0.0';

  const gameData = {
    generatedAt: new Date().toISOString(),
    dataVersion,
    perTalentToMax: { '7': 1, '8': 1, '9': 2, '10': 2 },
    characters: characters,
    materials: sortedMaterials,
    bosses: bossesList
  };

  // Ensure data directory exists
  const dataDir = path.dirname(GAME_JSON_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Write game.json
  fs.writeFileSync(GAME_JSON_PATH, JSON.stringify(gameData, null, 2));
  console.log(`Wrote ${GAME_JSON_PATH}`);
  console.log(`  Characters: ${characters.length}`);
  console.log(`  Materials: ${Object.keys(sortedMaterials).length}`);
  console.log(`  Bosses: ${bossesList.length}`);

  // Vendor icons
  vendorIcons(gameData);
}

/**
 * Vendor icons from remote host
 */
function vendorIcons(gameData) {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  const iconHost = 'https://gi.yatta.moe/assets/UI/';
  const { createHash } = require('crypto');

  let fetched = 0;
  let cached = 0;
  let failed = 0;

  // Collect all icon basenames
  const icons = new Set();

  for (const char of gameData.characters) {
    if (char.icon) icons.add(char.icon);
  }

  for (const mat of Object.values(gameData.materials)) {
    if (mat.icon) icons.add(mat.icon);
  }

  console.log(`\nVendoring ${icons.size} icons...`);

  // Download icons using synchronous HTTP
  const https = require('https');

  for (const icon of icons) {
    const iconPath = path.join(ICONS_DIR, `${icon}.png`);

    if (fs.existsSync(iconPath)) {
      cached++;
      continue;
    }

    try {
      const url = `${iconHost}${icon}.png`;
      const file = fs.createWriteStream(iconPath);

      https.get(url, (res) => {
        if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            fetched++;
            console.log(`  Fetched: ${icon}.png`);
          });
        } else {
          file.close();
          fs.unlinkSync(iconPath);
          failed++;
          console.log(`  Failed (${res.statusCode}): ${icon}.png`);
        }
      }).on('error', (err) => {
        if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
        failed++;
        console.log(`  Error: ${icon}.png - ${err.message}`);
      });
    } catch (e) {
      failed++;
      console.log(`  Error: ${icon}.png - ${e.message}`);
    }
  }

  console.log(`\nIcon vendored: ${fetched} fetched, ${cached} cached, ${failed} failed`);
}

// Run extraction
extract();