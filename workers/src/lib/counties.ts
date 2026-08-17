// County adjacency, for the registry reverse lookup.
//
// The reverse lookup asks "is this person, found on a website, an officer of
// any entity near this business?" Restricting that to the business's own county
// is too tight: a Garden City owner routinely incorporates through an attorney
// in Queens, and the Phase 3 forward match already lost `Brizel Med Spa` for
// exactly this reason — the Nassau business is registered in **Kings**.
//
// Widening to the whole state is too loose in the other direction. An officer
// match is a full-name match, and full names repeat: searching 4.27M NY
// entities for "John Smith" finds a John Smith, just not this one. Adjacency is
// the middle: the counties a business plausibly files in.
//
// Only the downstate NY counties are mapped, because that is where the campaign
// runs and a guessed adjacency is worse than none. Anything unmapped falls back
// to its own county alone, which is the conservative behaviour.

const NY_ADJACENT: Record<string, string[]> = {
  // Long Island proper, plus the two NYC boroughs on the same island — where
  // Long Island businesses actually file.
  Nassau:   ['Nassau', 'Suffolk', 'Queens', 'Kings', 'New York'],
  Suffolk:  ['Suffolk', 'Nassau', 'Queens'],
  Queens:   ['Queens', 'Nassau', 'Kings', 'New York', 'Bronx'],
  Kings:    ['Kings', 'Queens', 'New York', 'Richmond', 'Nassau'],
  'New York': ['New York', 'Kings', 'Queens', 'Bronx', 'Westchester'],
  Bronx:    ['Bronx', 'New York', 'Queens', 'Westchester'],
  Richmond: ['Richmond', 'Kings'],
  Westchester: ['Westchester', 'Bronx', 'New York', 'Rockland', 'Putnam'],
  Rockland: ['Rockland', 'Westchester', 'Orange'],
}

const BY_STATE: Record<string, Record<string, string[]>> = { NY: NY_ADJACENT }

/**
 * The counties to search for a business in `county`, itself first.
 *
 * Returns an empty array for an unknown county so the caller can decide
 * whether to search unrestricted — rather than silently returning every
 * county, which would turn a missing crosswalk entry into a statewide scan.
 */
export function adjacentCounties(state: string, county: string): string[] {
  if (!county) return []
  const map = BY_STATE[(state ?? '').toUpperCase()]
  return map?.[county] ?? [county]
}
