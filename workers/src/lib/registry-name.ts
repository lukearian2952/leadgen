// Person-vs-company classification for registry officer fields.
//
// ── Why this is the whole trick ──────────────────────────────────────────────
//
// NY's `dos_process_name` is populated on 98.3% of 4.27M rows, which looks like
// a name goldmine and is not. Measured on 800 Long Island wellness entities:
// 53–56% of the values are the entity's own name repeated, and much of the
// remainder is commercial registered agents. Only 35.5% are person-shaped.
// Across all three name fields, 49.4% of entities have a person-shaped name in
// at least one — and that is the ceiling before any match loss.
//
// A sample of five Nassau "MED SPA" entities pulled live shows every failure
// mode at once:
//
//   ALLURE MED SPAS INC.      dos_process_name = "Gene Rosen's Law Firm"    ← agent
//   APHRODIETY MED SPA LLC    dos_process_name = "APHRODIETY MED SPA LLC"   ← self
//   BELLA FIORE MED SPA INC.  dos_process_name = "BELLA FIORE MED SPA INC." ← self
//   CAREMED SPA & TREATMENT   registered_agent = "SPIEGEL & UTRERA P.A."    ← agent
//   DREAM SKIN CARE & MED SPA chairman_name    = "UZMA IQBAL"               ← person
//
// So the classifier has three jobs, in order: reject the entity name repeated
// back, reject commercial agents and law firms, and only then ask v1's
// `parseName` whether what is left looks like a human.
//
// FL is different and better: its file carries a P/C flag per officer, so the
// source itself says which are people. That flag is trusted when present and
// this classifier only runs as a cross-check.

import { parseName, type ParsedName } from './identity.js'

export type RegistryNameKind = 'person' | 'company' | 'unknown'

export interface ClassifiedRegistryName {
  kind: RegistryNameKind
  first: string
  last: string
  /** Why it was rejected, for the evidence trail. Empty when kind === 'person'. */
  reason: string
}

/**
 * Commercial registered-agent and law-firm operators.
 *
 * These are the professional agents that appear as `dos_process_name` or
 * `registered_agent_name` for thousands of unrelated businesses. Matching one
 * is decisive: whoever they are, they are not the owner of this business.
 */
const COMMERCIAL_AGENTS = [
  'ct corporation', 'c t corporation', 'corporation service company',
  'registered agents inc', 'registered agent', 'national registered agents',
  'northwest registered agent', 'united states corporation agents',
  'usa corporate services', 'incorp services', 'incorp', 'cogency global',
  'vcorp services', 'harbor compliance', 'legalzoom', 'zenbusiness',
  'swyft filings', 'business filings', 'capitol services', 'paracorp',
  'registered agent solutions', 'interstate agent services', 'blumberg',
  'the company corporation', 'spiegel & utrera', 'spiegel and utrera',
  'sunshine corporate filings', 'florida registered agent',
  'jumpstart filings', 'nevada agency', 'delaware trust', 'bizee',
  'inc authority', 'rocket lawyer', 'corpnet', 'mycompanyworks',
]

/**
 * Tokens that make a string an organisation regardless of how person-shaped
 * the rest of it looks. `parseName` has its own NON_PERSON_TOKENS list, but it
 * is tuned for website bylines ("Wellness Team") rather than for corporate
 * filings, which speak in suffixes.
 */
const ORG_MARKERS = new RegExp(
  [
    '\\b(llc|l\\.l\\.c|inc|incorporated|corp|corporation|ltd|limited|pllc|'
    + 'p\\.?l\\.?l\\.?c|pc|p\\.?c|pa|p\\.?a|llp|l\\.?l\\.?p|lp|plc)\\b',
    '\\b(company|companies|holdings?|enterprises?|ventures?|partners|partnership)\\b',
    '\\b(law firm|law office|law offices|attorneys?|counsel|esq)\\b',
    '\\b(services|solutions|group|associates|association|agency|agents?)\\b',
    '\\b(trust|bank|realty|properties|management|consulting)\\b',
    '\\b(clinic|center|centre|spa|salon|studio|medical|health|wellness|dental)\\b',
    '&',
  ].join('|'),
  'i',
)

/** Normalisation used for the "is this just the entity name again" test. */
export function normaliseEntityName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[.,'’"`]/g, '')
    .replace(/\b(llc|llc's|l l c|inc|incorporated|corp|corporation|ltd|limited|pllc|pc|pa|llp|lp|co|company|group|the|of|and)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Token-level containment, so "BELLA FIORE" still matches "BELLA FIORE MED SPA INC.". */
function repeatsEntityName(value: string, entityName: string): boolean {
  const a = normaliseEntityName(value)
  const b = normaliseEntityName(entityName)
  if (!a || !b) return false
  if (a === b) return true

  const at = new Set(a.split(' ').filter(t => t.length > 2))
  const bt = new Set(b.split(' ').filter(t => t.length > 2))
  if (!at.size || !bt.size) return false

  // Every meaningful token of the shorter string appears in the longer one.
  const [small, large] = at.size <= bt.size ? [at, bt] : [bt, at]
  let shared = 0
  for (const t of small) if (large.has(t)) shared++
  return shared === small.size
}

export function isCommercialAgent(value: string): boolean {
  const v = (value ?? '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  return COMMERCIAL_AGENTS.some(a => v.includes(a))
}

/**
 * Classify one registry name field.
 *
 * `entityName` is required, not optional: without it the single largest class
 * of false positives — the entity's own name, which is 53–56% of
 * `dos_process_name` — is undetectable.
 */
export function classifyRegistryName(
  value: string, entityName: string,
): ClassifiedRegistryName {
  const reject = (reason: string): ClassifiedRegistryName =>
    ({ kind: 'company', first: '', last: '', reason })

  const raw = (value ?? '').trim()
  if (!raw) return { kind: 'unknown', first: '', last: '', reason: 'empty' }

  if (repeatsEntityName(raw, entityName)) return reject('entity_name_repeat')
  if (isCommercialAgent(raw)) return reject('commercial_agent')
  if (ORG_MARKERS.test(raw)) return reject('org_marker')

  const parsed: ParsedName = parseName(raw)
  if (parsed.reject) {
    return { kind: 'unknown', first: '', last: '', reason: parsed.reject }
  }
  return { kind: 'person', first: parsed.first, last: parsed.last, reason: '' }
}

// ── Fixed-width name fields ──────────────────────────────────────────────────

/**
 * Split a Florida officer/agent name field.
 *
 * ── Measured, not assumed ────────────────────────────────────────────────────
 *
 * On `doc/cor/20260815c.txt` — 1,292 records, every line exactly 1,440 chars —
 * person names are not "First Last". The 42-char slot holds *three* fixed
 * sub-fields that the published layout document never mentions:
 *
 *   LAST (20)  FIRST (14)  MIDDLE (rest)
 *
 *   "JOVER               DANIELLA"                → Daniella Jover
 *   "HAGAN               NANAJACOB"               → Nanajacob Hagan
 *   "MANNERING           SAMMY         J"         → Sammy Mannering, middle J
 *   "REGISTERED AGENTS INC"                       → a company; the P/C flag says so
 *
 * The 14-char first-name width was established by measuring where the padding
 * run ends across all 1,553 person-typed officer entries in the file: 561 of
 * the 586 padded names end at exactly offset 14, 24 at 15, 1 at 7. So the field
 * is 14 wide and the stragglers are dirty rows, one of which
 * ("SANDRA CHOKRON M.D.") is an entire name crammed into the first-name slot.
 *
 * Rather than hardcode 14 and mangle those, the split is on the *padding run*:
 * the first name ends where two or more spaces begin. That reproduces the
 * 14-char layout on every well-formed row and degrades to "the first token" on
 * the malformed ones instead of slicing a name in half.
 *
 * Splitting on whitespace — the obvious reading — yields first="Jover",
 * last="Daniella": a wrong name on every single Florida row.
 */
export function splitFloridaName(field: string): { first: string; last: string } {
  const raw = field ?? ''

  // A person record is space-padded to the sub-field boundary, so column 20 is
  // preceded by whitespace. A value that runs straight through it is not using
  // this layout at all — it is a company name written flat ("REGISTERED AGENTS
  // INC" is 21 characters) — and slicing it yields last="REGISTERED AGENTS IN",
  // first="C". Return it whole and let the caller's company checks reject it.
  if (raw.length > 20 && raw[19] !== ' ' && raw[20] !== ' ') {
    return { first: '', last: raw.trim() }
  }

  const last = raw.slice(0, 20).trim()
  const region = raw.slice(20).replace(/\s+$/, '')
  if (!region) return { first: '', last }

  // End of the first-name sub-field: the start of the padding run before the
  // middle initial, or the whole region when there is no middle initial.
  const padding = region.match(/\s{2,}/)
  const firstField = padding ? region.slice(0, region.indexOf(padding[0])) : region
  // A single-spaced multi-token value is a malformed row; take the first token.
  const first = firstField.trim().split(/\s+/)[0] ?? ''

  if (!first) return { first: '', last }
  return { first: titleCase(first), last: titleCase(last) }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
}

// ── Officer priority ─────────────────────────────────────────────────────────

/**
 * Field priority for choosing which officer to use, per the Phase 3 brief:
 * `dos_process_name → chairman/ceo → registered agent`.
 *
 * Worth recording that the data argues for a different order. `chairman_name`
 * is populated on only 11.1% of NY rows but is a genuine officer field, while
 * `dos_process_name` is 98.3% populated and mostly the entity name repeated or
 * a law firm. After classification the difference is small — both filters catch
 * the junk — but where both survive, `dos_process_name` winning means a
 * personal-name process agent (an attorney filing on the business's behalf) can
 * outrank an actual named chairman. The brief's order is implemented as
 * specified; this is flagged rather than silently changed.
 */
export const NY_FIELD_RANK: Record<string, number> = {
  dos_process_name: 1,
  chairman_name: 2,
  registered_agent_name: 3,
}

/** FL title codes → a human title, for the ones that imply authority. */
export const FL_TITLE_CODES: Record<string, string> = {
  P: 'President', PRES: 'President', CEO: 'Chief Executive Officer',
  MGR: 'Manager', MGRM: 'Managing Member', AMBR: 'Authorized Member',
  MBR: 'Member', MEM: 'Member', DIR: 'Director', D: 'Director',
  VP: 'Vice President', V: 'Vice President', TREA: 'Treasurer', T: 'Treasurer',
  SECR: 'Secretary', S: 'Secretary', CHM: 'Chairman', C: 'Chairman',
  AP: 'Authorized Person', AR: 'Authorized Representative',
  PA: 'Partner', GP: 'General Partner', OWNR: 'Owner',
}

/**
 * FL officer codes that imply control of the business. MGR/AMBR/MBR dominate
 * the file (775 + 548 + 34 of 1,647 officer entries on the sample day) and are
 * the LLC equivalent of owner: a Florida LLC's "Authorized Member" is a member
 * of the LLC, i.e. an owner.
 */
export const FL_OWNER_GRADE_CODES = new Set([
  'P', 'PRES', 'CEO', 'MGR', 'MGRM', 'AMBR', 'MBR', 'MEM', 'CHM', 'C',
  'OWNR', 'GP', 'PA', 'DIR', 'D',
])
