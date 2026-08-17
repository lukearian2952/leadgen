// Ported from v1 `supabase/functions/_shared/niche-types.ts`.
// Google Place `types` no longer arrive from Place Details; gosom gives a single
// `category` string, so checkNicheTypes is fed [category] instead of an array.

// Gate rule 5: the Place Details `types` array has to look like the niche the
// user asked for.
//
// Google Text Search matches on free text, so "wellness" pulled in gyms, nail
// bars, supplement shops and the occasional restaurant. Filtering on the
// structured `types` array is far tighter than filtering on the name.

/**
 * Types Google puts on essentially every establishment. They carry no signal
 * and must never be treated as evidence that a place matches the niche.
 */
const GENERIC_TYPES = new Set([
  'point_of_interest', 'establishment', 'store', 'food', 'finance',
  'local_government_office', 'premise', 'subpremise', 'geocode',
])

interface NicheRule {
  /** Substrings that select this rule from the campaign's niche text. */
  keywords: string[]
  /** Place types that satisfy the rule. */
  allowed: string[]
  /**
   * Words to look for in gosom's free-text `category` when the Place-type
   * check fails.
   *
   * gosom emits one category string ("Vehicle wrapping service", "Sign shop",
   * "Car detailing service") from a vocabulary that is not Google's Place
   * types, so a type mismatch alone is weak evidence. Without hints the wrap
   * run dropped 4 of its 8 discovered businesses as `type_mismatch` — the
   * filter was rejecting the exact trade it was pointed at.
   */
  hints?: string[]
}

/**
 * Ordered — the first rule whose keyword appears in the niche wins, so put
 * specific niches ("med spa") before broad ones ("spa", "wellness").
 */
const NICHE_RULES: NicheRule[] = [
  {
    keywords: ['med spa', 'medspa', 'medical spa', 'aesthetic', 'botox', 'dermatolog'],
    allowed: ['spa', 'beauty_salon', 'doctor', 'health', 'hair_care', 'physiotherapist'],
  },
  {
    keywords: ['wellness', 'holistic', 'acupunctur', 'massage', 'day spa', 'spa'],
    allowed: [
      'spa', 'beauty_salon', 'health', 'physiotherapist', 'doctor',
      'gym', 'hair_care', 'chiropractor',
    ],
  },
  {
    keywords: ['dentist', 'dental', 'orthodont', 'endodont', 'periodont'],
    allowed: ['dentist', 'doctor', 'health'],
  },
  {
    keywords: ['chiropract'],
    allowed: ['chiropractor', 'doctor', 'health', 'physiotherapist'],
  },
  {
    keywords: ['physical therapy', 'physiotherap', 'rehab'],
    allowed: ['physiotherapist', 'doctor', 'health', 'gym'],
  },
  {
    keywords: ['veterinar', 'vet clinic', 'animal hospital'],
    allowed: ['veterinary_care', 'health'],
  },
  {
    keywords: ['doctor', 'physician', 'medical', 'clinic', 'pediatric', 'urgent care'],
    allowed: ['doctor', 'health', 'hospital', 'physiotherapist', 'dentist'],
  },
  {
    keywords: ['gym', 'fitness', 'crossfit', 'pilates', 'yoga', 'personal train'],
    allowed: ['gym', 'health', 'spa'],
  },
  {
    keywords: ['salon', 'barber', 'hair', 'nail', 'lash', 'brow', 'esthetic'],
    allowed: ['beauty_salon', 'hair_care', 'spa'],
  },
  {
    keywords: ['law', 'attorney', 'lawyer', 'legal', 'solicitor'],
    allowed: ['lawyer'],
  },
  {
    keywords: ['account', 'cpa', 'bookkeep', 'tax prep'],
    allowed: ['accounting', 'finance'],
  },
  {
    keywords: ['insurance'],
    allowed: ['insurance_agency', 'finance'],
  },
  {
    keywords: ['real estate', 'realtor', 'property manage'],
    allowed: ['real_estate_agency'],
  },
  {
    keywords: ['roof'],
    allowed: ['roofing_contractor', 'general_contractor', 'home_goods_store'],
  },
  {
    keywords: ['plumb'],
    allowed: ['plumber', 'general_contractor'],
  },
  {
    keywords: ['hvac', 'heating', 'air conditioning'],
    allowed: ['hvac_contractor', 'general_contractor', 'plumber', 'electrician'],
  },
  {
    keywords: ['electric'],
    allowed: ['electrician', 'general_contractor'],
  },
  {
    keywords: ['landscap', 'lawn', 'tree service'],
    allowed: ['general_contractor', 'park', 'florist', 'home_goods_store'],
  },
  {
    keywords: ['contractor', 'remodel', 'construction', 'renovation'],
    allowed: ['general_contractor', 'electrician', 'plumber', 'painter', 'roofing_contractor'],
  },
  {
    // Before the broad 'auto' rule, which would otherwise swallow it and admit
    // every mechanic and tyre shop. gosom labels these "Vehicle wrapping
    // service", "Car detailing service" or "Sign shop" — none of which is a
    // Google Place type, so the keyword fallback in maps:discover is what
    // actually does the work here. The rule still narrows the type side.
    keywords: ['vehicle wrap', 'car wrap', 'wrap shop', 'vinyl wrap',
               'paint protection', 'ppf', 'vehicle graphic'],
    allowed: ['car_repair', 'painter', 'car_wash', 'auto_parts_store',
              'general_contractor', 'car_dealer'],
    hints: ['wrap', 'vinyl', 'graphic', 'sign', 'tint', 'decal', 'detail',
            'auto body', 'body shop', 'custom car', 'car audio'],
  },
  {
    keywords: ['auto', 'car repair', 'mechanic', 'body shop', 'tire'],
    allowed: ['car_repair', 'car_dealer', 'car_wash'],
  },
  {
    keywords: ['restaurant', 'cafe', 'coffee', 'bakery', 'bar ', 'pizzeria'],
    allowed: ['restaurant', 'cafe', 'bakery', 'bar', 'meal_takeaway', 'meal_delivery'],
  },
]

export interface NicheFilter {
  allowed: Set<string>
  /** False when no rule matched the niche — rule 5 is then a no-op. */
  active: boolean
  matchedKeyword: string
  /** Free-text category words that rescue a Place-type mismatch. */
  hints: string[]
}

/**
 * Alternative search phrasings for a niche.
 *
 * Google Maps matches the search string against how businesses describe
 * *themselves*, and the phrase a buyer uses is often not one. Measured on the
 * live scraper, two cities at depth 10:
 *
 *   "vehicle wrap shop in {city}"   →  9 rows
 *   "car wrap" / "vehicle wraps"    → 19 rows
 *
 * Same businesses, same cities, same moment — the trade word is "wrap", and
 * "shop" narrows it to almost nothing. Returning several phrasings and
 * deduping on place_id costs one extra query per city and roughly doubles
 * coverage.
 *
 * Only defined where it has been measured. Everything else returns the niche
 * unchanged, because an invented synonym would silently widen the funnel.
 */
export function nicheQueryVariants(niche: string): string[] {
  const n = niche.toLowerCase()
  if (/vehicle wrap|car wrap|wrap shop|vinyl wrap/.test(n)) {
    return ['car wrap', 'vehicle wraps', 'vinyl wrap']
  }
  return [niche]
}

export function resolveNicheFilter(niche: string): NicheFilter {
  const n = niche.toLowerCase()
  for (const rule of NICHE_RULES) {
    const hit = rule.keywords.find(k => n.includes(k))
    if (hit) {
      return {
        allowed: new Set(rule.allowed), active: true, matchedKeyword: hit,
        hints: rule.hints ?? [],
      }
    }
  }
  return { allowed: new Set(), active: false, matchedKeyword: '', hints: [] }
}

/**
 * Gate rule 5. Returns null when the place matches, or a reject reason.
 *
 * A place with no meaningful types at all is rejected too — that is almost
 * always a bare geocode result rather than a real business.
 */
export function checkNicheTypes(types: string[], filter: NicheFilter): string | null {
  if (!filter.active) return null
  const meaningful = (types ?? []).filter(t => !GENERIC_TYPES.has(t))
  if (!meaningful.length) return 'no_place_types'
  const hit = meaningful.some(t => filter.allowed.has(t))
  return hit ? null : `type_mismatch:${meaningful.slice(0, 3).join('|')}`
}
