// Business-name normalisation, shared by Maps discovery and registry matching.
//
// This function has to be *the same one* on both sides. `businesses.name_norm`
// is written by maps:discover and `registry_entities.name_norm` by the registry
// adapters, and registry:match joins them with pg_trgm similarity. Two
// near-identical normalisers would silently depress every similarity score by
// a few points and push borderline matches under the 0.6 threshold — a whole
// class of missing names with no error anywhere.
//
// It lived in jobs/maps-discover.ts through Phase 2 and is re-exported from
// there so nothing that imported it breaks.

/**
 * Lowercase, strip corporate suffixes and punctuation, collapse whitespace.
 *
 * Suffix stripping is what makes "Radiance Med Spa" and "RADIANCE MEDICAL
 * AESTHETICS LLC" comparable at all — trigram similarity between the raw
 * strings is dragged down by "llc" and the punctuation before the real tokens
 * get a vote.
 */
export function normaliseName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[.,''"`]/g, '')
    .replace(/\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|limited|pllc|pc|pa|co|company|group|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Tokens generic enough that matching on them alone would return the whole
 * niche. "Med Spa of Garden City" and "Garden City Med Spa" share every token
 * here and nothing else — a lookup keyed on them is a lookup keyed on nothing.
 */
const GENERIC_TOKENS = new Set([
  'med', 'medi', 'medical', 'spa', 'spas', 'medspa', 'wellness', 'health',
  'aesthetic', 'aesthetics', 'esthetics', 'beauty', 'skin', 'skincare',
  'clinic', 'center', 'centre', 'studio', 'salon', 'lounge', 'bar', 'shop',
  'laser', 'cosmetic', 'cosmetics', 'care', 'body', 'face', 'glow', 'new',
  'york', 'ny', 'long', 'island', 'east', 'west', 'north', 'south', 'city',
  'and', 'of', 'at', 'by', 'for', 'llc', 'inc', 'the', 'dr', 'doctor',
  'institute', 'group', 'associates', 'services', 'solutions', 'boutique',
  'plastic', 'surgery', 'surgical', 'derm', 'dermatology', 'family', 'advanced',
  'premier', 'elite', 'luxe', 'luxury', 'modern', 'pure', 'true', 'true',
])

/**
 * The tokens worth sending to a registry as a name filter.
 *
 * Returns the distinctive ones — brand words like "brizel", "aphrodiety",
 * "asunshine" — longest first, because the longest token is the least likely
 * to collide. Falls back to the longest raw token when a business name is
 * entirely generic ("The Med Spa"), since one over-broad query is better than
 * no lookup at all.
 */
export function distinctiveTokens(name: string, max = 2): string[] {
  const tokens = normaliseName(name).split(' ').filter(Boolean)
  const distinctive = tokens
    .filter(t => t.length >= 4 && !GENERIC_TOKENS.has(t))
    .sort((a, b) => b.length - a.length)

  if (distinctive.length) return distinctive.slice(0, max)

  const fallback = tokens.filter(t => t.length >= 3).sort((a, b) => b.length - a.length)
  return fallback.slice(0, 1)
}
