/**
 * GOODkey derivation — must match Irminsul / Genshin Optimizer exactly
 * Convert a display name to its GOOD key.
 *
 * Rules:
 * - keep [A-Za-z0-9] only
 * - uppercase the first alnum after any space
 * - a space sets the "capitalize next" flag
 * - apostrophes, hyphens, punctuation dropped WITHOUT affecting capitalization
 *
 * Examples: "Hu Tao"→"HuTao", "Shard of a Foul Legacy"→"ShardOfAFoulLegacy"
 */

function nameToGoodKey(name) {
  let result = '';
  let capitalizeNext = true;

  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (/[A-Za-z0-9]/.test(ch)) {
      if (capitalizeNext) {
        result += ch.toUpperCase();
        capitalizeNext = false;
      } else {
        result += ch.toLowerCase();
      }
    } else if (/\s/.test(ch)) {
      // Only whitespace sets the capitalize-next flag
      capitalizeNext = true;
    }
    // Apostrophes, hyphens, other punctuation are dropped WITHOUT
    // affecting capitalization (e.g. "Dvalin's Plume" -> "DvalinsPlume")
  }

  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nameToGoodKey };
}
