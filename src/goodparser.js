const { nameToGoodKey } = require('./goodkey');

/**
 * Parse a GOOD JSON string into a normalized account object.
 * @param {string} goodString Raw GOOD export text
 * @returns {{characters: Array, materialCounts: Object}}
 * @throws {Error} If JSON is invalid or not a GOOD export
 */
function parseGOOD(goodString) {
  let data;
  try {
    data = JSON.parse(goodString);
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
    talent: ch.talent
  }));

  // Material inventory keyed by GOODkey -> owned count
  // Missing "materials" field => all inventory treated as 0 (UI must warn)
  const materialCounts = {};
  if (data.materials) {
    for (const [k, v] of Object.entries(data.materials)) {
      materialCounts[k] = v;
    }
  }

  return {
    characters,
    materialCounts,
    hasMaterials: !!data.materials
  };
}

module.exports = { parseGOOD };
