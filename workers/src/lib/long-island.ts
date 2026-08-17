// Nassau and Suffolk county places, for verifying that a "Long Island" campaign
// actually landed on Long Island.
//
// This is a *membership* list and is deliberately separate from the expansion
// list in locations.ts, which is a *query* list. The query list is 30 towns
// chosen to give Google good coverage; using it to judge membership undercounts
// badly — the first clean run scored 57/75 as Long Island when the true figure
// was higher, because Westbury and Port Jefferson Station are unambiguously
// Nassau and Suffolk but were not among the 30 queried.
//
// Villages, hamlets and CDPs, since Google returns whichever the business used.

const NASSAU = [
  'atlantic beach', 'baldwin', 'baldwin harbor', 'barnum island', 'bayville',
  'bellerose', 'bellerose terrace', 'bellmore', 'bethpage', 'brookville',
  'carle place', 'cedarhurst', 'centre island', 'cove neck', 'east atlantic beach',
  'east eddington', 'east garden city', 'east hills', 'east massapequa',
  'east meadow', 'east norwich', 'east rockaway', 'east williston', 'elmont',
  'farmingdale', 'floral park', 'flower hill', 'franklin square', 'freeport',
  'garden city', 'garden city park', 'garden city south', 'glen cove',
  'glen head', 'glenwood landing', 'great neck', 'great neck estates',
  'great neck gardens', 'great neck plaza', 'greenvale', 'harbor hills',
  'harbor isle', 'hempstead', 'herricks', 'hewlett', 'hewlett bay park',
  'hewlett harbor', 'hewlett neck', 'hicksville', 'inwood', 'island park',
  'islandia', 'jericho', 'kensington', 'kings point', 'lake success',
  'lakeview', 'lattingtown', 'laurel hollow', 'lawrence', 'levittown',
  'lido beach', 'locust valley', 'long beach', 'lynbrook', 'malverne',
  'malverne park oaks', 'manhasset', 'manhasset hills', 'manorhaven',
  'massapequa', 'massapequa park', 'matinecock', 'meadowmere park', 'merrick',
  'mill neck', 'mineola', 'munsey park', 'muttontown', 'new cassel',
  'new hyde park', 'north bellmore', 'north hills', 'north lynbrook',
  'north massapequa', 'north merrick', 'north new hyde park', 'north valley stream',
  'north wantagh', 'oceanside', 'old bethpage', 'old brookville', 'old westbury',
  'oyster bay', 'oyster bay cove', 'plainedge', 'plainview', 'plandome',
  'plandome heights', 'plandome manor', 'point lookout', 'port washington',
  'port washington north', 'rockville centre', 'roosevelt', 'roslyn',
  'roslyn estates', 'roslyn harbor', 'roslyn heights', 'russell gardens',
  'saddle rock', 'saddle rock estates', 'salisbury', 'sands point', 'sea cliff',
  'seaford', 'search light', 'south farmingdale', 'south floral park',
  'south hempstead', 'south valley stream', 'stewart manor', 'syosset',
  'thomaston', 'uniondale', 'university gardens', 'upper brookville',
  'valley stream', 'wantagh', 'west hempstead', 'westbury', 'williston park',
  'woodbury', 'woodmere', 'woodsburgh',
]

const SUFFOLK = [
  'amagansett', 'amityville', 'aquebogue', 'asharoken', 'babylon', 'baiting hollow',
  'bay shore', 'bayport', 'bayville', 'belle terre', 'bellport', 'blue point',
  'bohemia', 'brentwood', 'bridgehampton', 'brightwaters', 'brookhaven',
  'calverton', 'centereach', 'centerport', 'central islip', 'cold spring harbor',
  'commack', 'copiague', 'coram', 'cutchogue', 'deer park', 'dering harbor',
  'dix hills', 'east farmingdale', 'east hampton', 'east hampton north',
  'east islip', 'east marion', 'east moriches', 'east northport', 'east patchogue',
  'east quogue', 'east setauket', 'eastport', 'eatons neck', 'elwood',
  'farmingville', 'fire island', 'fishers island', 'flanders', 'fort salonga',
  'greenlawn', 'greenport', 'greenport west', 'hampton bays', 'hauppauge',
  'head of the harbor', 'holbrook', 'holtsville', 'huntington', 'huntington bay',
  'huntington station', 'islandia', 'islip', 'islip terrace', 'jamesport',
  'kings park', 'lake grove', 'lake ronkonkoma', 'laurel', 'lindenhurst',
  'lloyd harbor', 'manorville', 'mastic', 'mastic beach', 'mattituck',
  'medford', 'melville', 'middle island', 'miller place', 'montauk',
  'moriches', 'mount sinai', 'napeague', 'nesconset', 'new suffolk',
  'nissequogue', 'north amityville', 'north babylon', 'north bay shore',
  'north bellport', 'north great river', 'north haven', 'north lindenhurst',
  'north patchogue', 'north sea', 'northampton', 'northport', 'northville',
  'oakdale', 'ocean beach', 'old field', 'orient', 'patchogue', 'peconic',
  'poquott', 'port jefferson', 'port jefferson station', 'quiogue', 'quogue',
  'remsenburg', 'remsenburg-speonk', 'ridge', 'riverhead', 'riverside',
  'rocky point', 'ronkonkoma', 'sag harbor', 'sagaponack', 'saltaire',
  'sayville', 'selden', 'setauket', 'setauket-east setauket', 'shelter island',
  'shelter island heights', 'shinnecock hills', 'shirley', 'shoreham',
  'smithtown', 'sound beach', 'south huntington', 'south jamesport',
  'southampton', 'southold', 'speonk', 'springs', 'st. james', 'saint james',
  'stony brook', 'terryville', 'tuckahoe', 'united states military academy',
  'village of the branch', 'wading river', 'wainscott', 'water mill',
  'west babylon', 'west bay shore', 'west hampton dunes', 'west hills',
  'west islip', 'west sayville', 'westhampton', 'westhampton beach',
  'wheatley heights', 'wyandanch', 'yaphank',
]

export const NASSAU_PLACES = new Set(NASSAU)
export const SUFFOLK_PLACES = new Set(SUFFOLK)

function normalise(city: string): string {
  return (city ?? '')
    .toLowerCase()
    .replace(/\bny\b|\bnew york\b/g, '')
    .replace(/[.,]/g, '')
    // Google returns both "Mt Sinai" and "Mount Sinai" for the same hamlet, and
    // the abbreviated form was the only thing keeping 2 of 75 rows off the map.
    .replace(/\bmt\b/g, 'mount')
    .replace(/\bst\b/g, 'saint')
    .replace(/\bft\b/g, 'fort')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Which Long Island county a place is in, or null. */
export function longIslandCounty(city: string): 'Nassau' | 'Suffolk' | null {
  const key = normalise(city)
  if (!key) return null
  if (NASSAU_PLACES.has(key)) return 'Nassau'
  if (SUFFOLK_PLACES.has(key)) return 'Suffolk'
  return null
}

export function isLongIsland(city: string): boolean {
  return longIslandCounty(city) !== null
}
