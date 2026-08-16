// Ported from v1 `supabase/functions/_shared/geo.ts`.
// The Deno/Anthropic fallback is dropped — Phase 2 resolves scope statically and
// the model call belongs in the enrich worker, not in a geo helper.

// Resolving "is this business actually in the place the user asked for?"
//
// The old pipeline trusted the search query — it asked Google for "med spa in
// Hicksville" and assumed everything that came back was in New York. Google's
// Text Search happily returns out-of-region matches on thin queries, which is
// how a "Wellness New York" run ended up with Troy MI, East Bay CA, Grand
// Bahama and several Canadian businesses. Gate rule 4 checks the address the
// Place Details endpoint actually returns instead.

export interface LocationScope {
  /** Accepted administrative_area_level_1 short codes, e.g. ['NY']. Empty = any. */
  stateCodes: string[]
  /** Accepted country short codes, e.g. ['US']. Empty = any. */
  countryCodes: string[]
  /** How the scope was determined — logged so a bad scope is debuggable. */
  source: 'static' | 'ai' | 'unscoped'
}

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
}

const CA_PROVINCES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK',
}

const US_CODES = new Set(Object.values(US_STATES))
const CA_CODES = new Set(Object.values(CA_PROVINCES))

/**
 * Well-known sub-state regions. A user typing "Long Island, NY" or "Hampton
 * Roads" means a specific state even though the phrase names no state.
 */
const REGION_STATE: Record<string, string> = {
  'long island': 'NY', 'hudson valley': 'NY', 'westchester': 'NY',
  'nyc': 'NY', 'new york city': 'NY', 'brooklyn': 'NY', 'queens': 'NY',
  'manhattan': 'NY', 'bronx': 'NY', 'staten island': 'NY', 'upstate new york': 'NY',
  'bay area': 'CA', 'east bay': 'CA', 'south bay': 'CA', 'silicon valley': 'CA',
  'socal': 'CA', 'southern california': 'CA', 'northern california': 'CA',
  'orange county': 'CA', 'inland empire': 'CA', 'san fernando valley': 'CA',
  'hampton roads': 'VA', 'northern virginia': 'VA', 'nova': 'VA',
  'dfw': 'TX', 'dallas fort worth': 'TX', 'rio grande valley': 'TX',
  'south florida': 'FL', 'central florida': 'FL', 'tampa bay': 'FL',
  'treasure coast': 'FL', 'space coast': 'FL', 'panhandle': 'FL',
  'chicagoland': 'IL', 'twin cities': 'MN', 'puget sound': 'WA',
  'front range': 'CO', 'triangle': 'NC', 'research triangle': 'NC',
  'lowcountry': 'SC', 'the berkshires': 'MA', 'cape cod': 'MA',
  'jersey shore': 'NJ', 'main line': 'PA', 'lehigh valley': 'PA',
}

/** Metro names that are unambiguous enough to pin a state. */
const METRO_STATE: Record<string, string> = {
  'san francisco': 'CA', 'los angeles': 'CA', 'san diego': 'CA',
  'sacramento': 'CA', 'san jose': 'CA', chicago: 'IL', houston: 'TX',
  austin: 'TX', 'san antonio': 'TX', dallas: 'TX', phoenix: 'AZ',
  denver: 'CO', seattle: 'WA', miami: 'FL', orlando: 'FL', tampa: 'FL',
  jacksonville: 'FL', atlanta: 'GA', boston: 'MA', 'las vegas': 'NV',
  portland: 'OR', minneapolis: 'MN', nashville: 'TN', memphis: 'TN',
  charlotte: 'NC', raleigh: 'NC', detroit: 'MI', philadelphia: 'PA',
  pittsburgh: 'PA', baltimore: 'MD', richmond: 'VA', 'virginia beach': 'VA',
  'salt lake city': 'UT', 'kansas city': 'MO', 'st louis': 'MO',
  'saint louis': 'MO', cleveland: 'OH', columbus: 'OH', cincinnati: 'OH',
  indianapolis: 'IN', milwaukee: 'WI', 'new orleans': 'LA', albuquerque: 'NM',
  'oklahoma city': 'OK', tulsa: 'OK', omaha: 'NE', boise: 'ID',
  'toronto': 'ON', 'vancouver': 'BC', 'montreal': 'QC', 'calgary': 'AB',
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Best-effort static resolution. Returns null when nothing matches so the
 * caller can fall back to the model.
 */
function scopeFromStatic(location: string): LocationScope | null {
  const norm = norm_(location)

  // Trailing state code: "Long Island, NY" / "Austin TX"
  const codeMatch = norm.match(/(?:^|\s)([a-z]{2})$/)
  if (codeMatch) {
    const code = codeMatch[1].toUpperCase()
    if (US_CODES.has(code)) return { stateCodes: [code], countryCodes: ['US'], source: 'static' }
    if (CA_CODES.has(code)) return { stateCodes: [code], countryCodes: ['CA'], source: 'static' }
  }

  // Full state / province name anywhere in the string.
  for (const [name, code] of Object.entries(US_STATES)) {
    if (norm === name || norm.endsWith(` ${name}`) || norm.startsWith(`${name} `) || norm.includes(` ${name} `)) {
      return { stateCodes: [code], countryCodes: ['US'], source: 'static' }
    }
  }
  for (const [name, code] of Object.entries(CA_PROVINCES)) {
    if (norm === name || norm.endsWith(` ${name}`) || norm.includes(` ${name} `)) {
      return { stateCodes: [code], countryCodes: ['CA'], source: 'static' }
    }
  }

  for (const [region, code] of Object.entries(REGION_STATE)) {
    if (norm.includes(region)) {
      return {
        stateCodes: [code],
        countryCodes: [CA_CODES.has(code) ? 'CA' : 'US'],
        source: 'static',
      }
    }
  }

  for (const [metro, code] of Object.entries(METRO_STATE)) {
    if (norm === metro || norm.startsWith(`${metro} `) || norm.includes(` ${metro} `)) {
      return {
        stateCodes: [code],
        countryCodes: [CA_CODES.has(code) ? 'CA' : 'US'],
        source: 'static',
      }
    }
  }

  if (/\b(usa|united states|u s a|nationwide|america)\b/.test(norm)) {
    return { stateCodes: [], countryCodes: ['US'], source: 'static' }
  }
  if (/\bcanada\b/.test(norm)) {
    return { stateCodes: [], countryCodes: ['CA'], source: 'static' }
  }

  return null
}

// Named separately so the regex-heavy normalisation is easy to unit-check.
function norm_(s: string): string { return normalise(s) }

/**
 * Resolve the requested location to the set of states/countries a result is
 * allowed to sit in. Falls back to Claude for phrasings the static tables miss,
 * and finally to an unscoped result (which disables gate rule 4 rather than
 * rejecting everything — a scope we cannot determine must not silently empty
 * the export).
 */
/**
 * Resolve the requested location to the set of states/countries a result may
 * sit in. Static only: v1 fell back to a Haiku call here, but a geo helper that
 * can make a network request is a geo helper that can fail mid-gate. An
 * unresolvable location yields `unscoped`, which disables the filter rather
 * than silently emptying the export.
 */
export function resolveLocationScope(location: string): LocationScope {
  return scopeFromStatic(location) ?? { stateCodes: [], countryCodes: [], source: 'unscoped' }
}

export interface AddressFacts {
  state: string
  country: string
  formattedAddress: string
}

interface AddressComponent {
  long_name?: string
  short_name?: string
  types?: string[]
}

/** Pull the state/country codes out of a Place Details address_components array. */
export function extractAddressFacts(
  components: AddressComponent[] | undefined,
  formattedAddress: string,
): AddressFacts {
  let state = ''
  let country = ''
  for (const c of components ?? []) {
    const types = c.types ?? []
    if (types.includes('administrative_area_level_1')) state = (c.short_name ?? '').toUpperCase()
    if (types.includes('country')) country = (c.short_name ?? '').toUpperCase()
  }
  return { state, country, formattedAddress: formattedAddress ?? '' }
}

/** Gate rule 4. Returns null when in scope, or a reject reason when not. */
export function checkInScope(facts: AddressFacts, scope: LocationScope): string | null {
  if (scope.source === 'unscoped') return null

  if (scope.countryCodes.length) {
    if (!facts.country) return 'no_country_on_place'
    if (!scope.countryCodes.includes(facts.country)) {
      return `country_mismatch:${facts.country}`
    }
  }
  if (scope.stateCodes.length) {
    if (!facts.state) return 'no_state_on_place'
    if (!scope.stateCodes.includes(facts.state)) {
      return `state_mismatch:${facts.state}`
    }
  }
  return null
}

/**
 * Country-code TLDs that contradict the requested country. A US campaign
 * turning up .co.uk / .ca / .au domains was one of the reported symptoms, and
 * it usually means Google matched a same-named business abroad.
 */
const CC_TLD_COUNTRY: Record<string, string> = {
  uk: 'GB', gb: 'GB', ca: 'CA', au: 'AU', nz: 'NZ', ie: 'IE', in: 'IN',
  de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', se: 'SE', no: 'NO',
  dk: 'DK', fi: 'FI', pl: 'PL', pt: 'PT', br: 'BR', mx: 'MX', za: 'ZA',
  ph: 'PH', sg: 'SG', my: 'MY', ae: 'AE', ch: 'CH', at: 'AT', be: 'BE',
  bs: 'BS', jm: 'JM', bb: 'BB', tt: 'TT',
}

/** Returns a reject reason when a domain's ccTLD contradicts the scope. */
export function checkDomainCountry(domain: string, scope: LocationScope): string | null {
  if (!domain || !scope.countryCodes.length) return null
  const tld = domain.split('.').pop()?.toLowerCase() ?? ''
  const implied = CC_TLD_COUNTRY[tld]
  if (implied && !scope.countryCodes.includes(implied)) {
    return `domain_cctld_mismatch:.${tld}`
  }
  return null
}
