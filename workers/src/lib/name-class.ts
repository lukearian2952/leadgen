// Name classes — the replacement for the binary owner-title gate.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// The Phase 2 audit measured where the 75-business run actually lost names:
//
//   leads with a person extracted from the site   39
//   leads named (owner-grade title)               18
//   person found, rejected on title               21   ← the wall
//   no person found at all                        15
//
// Coverage was fine; 126 about/team pages were reached. The 21 were rejected
// for titles like "board-certified Nurse Practitioner", "CRNA", "PA", "MD".
// At a med spa the NP, PA or MD frequently *is* the owner — so discarding
// them costs more than it protects. But "frequently" is not "always", and a
// staff nurse addressed as the owner is exactly the failure this pipeline
// exists to prevent.
//
// So: three classes, not two.
//
//   owner_grade    Owner / Founder / CEO / Managing Partner / Medical Director.
//                  Ownership is asserted by the title itself. Usable alone.
//   clinical_lead  MD, DO, NP, PA, RN, CRNA, DDS, LAc, "board-certified …".
//                  A credential, not a claim of ownership. Held, and promoted
//                  to owner-grade ONLY on independent corroboration.
//   staff          Esthetician, LMT, Massage Therapist, receptionist, and
//                  anything else. Never usable as an owner name.
//
// ── The "Dr." change ─────────────────────────────────────────────────────────
//
// v1's OWNER_TITLE_RE treats a leading `Dr. ` as owner-grade. Under the new
// policy that is wrong for the same reason "MD" is: it is a credential. It is
// routed to clinical_lead here. identity.ts is left untouched so the ported v1
// gate and its tests keep their exact semantics; this module is what the
// pipeline consults.

export type NameClass = 'owner_grade' | 'clinical_lead' | 'staff'

/**
 * Titles that assert ownership or ultimate authority over the business.
 *
 * Kept in sync in substance with identity.ts's OWNER_TITLE_RE minus the `dr.`
 * clause. "Medical Director" stays here deliberately: it is an appointment to
 * run the practice, not a credential someone holds.
 */
const OWNER_GRADE_RE = new RegExp(
  [
    'owner', 'owner-?operator', 'founder', 'co-?founder', 'ceo',
    'chief executive', 'chief medical officer', 'cmo\\b',
    'president', 'principal', 'proprietor',
    'managing director', 'managing partner', 'managing member',
    'clinic director', 'medical director', 'practice owner', 'practice director',
    'practice manager', 'spa director', 'executive director',
    'partner\\b',
  ].join('|'),
  'i',
)

/**
 * Clinical credentials and licensed-practitioner roles.
 *
 * Two shapes, deliberately separated:
 *
 *   - Spelled-out roles are matched case-insensitively. They are unambiguous.
 *   - Bare letter credentials are matched **case-sensitively and
 *     word-bounded**, because lowercased they collide with ordinary words and
 *     with entity suffixes. `PA` is the worst: it is Pennsylvania, it is
 *     "P.A." in a Florida professional-association name, and it is in v1's own
 *     NON_PERSON_TOKENS list. Matching /pa/i against a title field would
 *     classify "Spa Manager" as a physician assistant.
 */
/**
 * Clinical roles that must be decided **before** the staff list gets a vote.
 *
 * "Physician Assistant" contains "assistant", and the staff list is checked
 * first because it is the more specific of the two. A negative lookahead on
 * `assistant` does not save it — "physician" appears *before* the word, not
 * after — so a PA was being classified as staff, which is precisely one of the
 * 21 titles this phase exists to stop discarding.
 */
const CLINICAL_PRIORITY_RE = new RegExp(
  [
    'nurse practitioner', 'physician assistant', 'physician’s assistant',
    "physician's assistant", 'physician associate',
    'medical assistant director', 'nurse anesthetist', 'registered nurse',
    'nurse injector', 'aesthetic injector', 'lead injector',
  ].join('|'),
  'i',
)

const CLINICAL_WORD_RE = new RegExp(
  [
    'nurse practitioner', 'physician assistant', 'physician’s assistant',
    "physician's assistant", 'registered nurse', 'nurse anesthetist',
    'physician', 'doctor', 'dentist', 'acupuncturist', 'acupuncture',
    'dermatologist', 'surgeon', 'anesthesiologist', 'naturopath',
    'chiropractor', 'optometrist', 'podiatrist', 'pharmacist',
    'board[- ]certified', 'nurse injector', 'aesthetic injector',
    'medical provider', 'clinical director', 'lead injector',
    'medical aesthetician', 'provider',
    // `\s|$` rather than `\s`: a title of exactly "Dr." or "Dr" is trimmed
    // before it gets here, so requiring a following space never matched it.
    'dr\\.?(\\s|$)',
  ].join('|'),
  'i',
)

/** Case-SENSITIVE. See the note above on why lowercasing these is unsafe. */
const CLINICAL_CRED_RE =
  /(^|[^A-Za-z])(M\.?D|D\.?O|N\.?P|P\.?A|R\.?N|C\.?R\.?N\.?A|D\.?D\.?S|D\.?M\.?D|L\.?Ac|A\.?R\.?N\.?P|F\.?N\.?P|D\.?N\.?P|P\.?A\.?-?C)\.?([^A-Za-z]|$)/

/**
 * Explicitly-not-a-decision-maker roles. Checked before the clinical patterns
 * so "Licensed Massage Therapist" does not reach `clinical_lead` on the word
 * "therapist" — an LMT at a med spa is staff, and the Phase 2 audit rejected
 * three of them correctly.
 */
const STAFF_RE = new RegExp(
  [
    'esthetician', 'aesthetician', 'massage therapist', 'l\\.?m\\.?t\\b',
    'receptionist', 'front desk', 'front office', 'coordinator',
    'assistant\\b(?!.*physician)', 'technician', 'consultant',
    'hairdresser', 'hair stylist', 'stylist', 'barber', 'cosmetologist',
    'instructor', 'trainer', 'concierge', 'host', 'intern',
    'general staff', 'staff\\b', 'associate\\b', 'specialist',
    'representative', 'advisor', 'counselor',
  ].join('|'),
  'i',
)

/**
 * Classify a title string.
 *
 * Precedence is owner-grade → staff → clinical → staff-by-default. Owner-grade
 * first because "Owner & Nurse Practitioner" is an owner who happens to be an
 * NP, and "Founder / Esthetician" is a founder. Staff before clinical because
 * the staff list is the more specific of the two.
 */
export function classifyTitle(rawTitle: string): NameClass {
  const title = (rawTitle ?? '').trim()
  if (!title) return 'staff'

  if (OWNER_GRADE_RE.test(title)) return 'owner_grade'
  if (CLINICAL_PRIORITY_RE.test(title)) return 'clinical_lead'
  if (STAFF_RE.test(title)) return 'staff'
  if (CLINICAL_WORD_RE.test(title) || CLINICAL_CRED_RE.test(title)) return 'clinical_lead'
  return 'staff'
}

/**
 * A clinical credential can also be carried on the *name* rather than the
 * title — "Joseph Pham, NP" with the title column blank. The Phase 2 audit had
 * seven blank titles among the 21 rejections, so the name is worth reading.
 */
export function classifyPersonName(fullName: string): NameClass | null {
  const name = (fullName ?? '').trim()
  if (!name) return null
  // Only the credential tail after a comma, so "Dr" inside "Drew" cannot fire.
  const tail = name.includes(',') ? name.slice(name.indexOf(',')) : ''
  if (tail && CLINICAL_CRED_RE.test(tail)) return 'clinical_lead'
  if (/^dr\.?\s/i.test(name)) return 'clinical_lead'
  return null
}

/** The class of a person, taking the stronger of their title and their name. */
export function classifyPerson(fullName: string, title: string): NameClass {
  const byTitle = classifyTitle(title)
  if (byTitle === 'owner_grade') return 'owner_grade'
  const byName = classifyPersonName(fullName)
  if (byName === 'clinical_lead') return 'clinical_lead'
  return byTitle
}

// ── Corroboration ────────────────────────────────────────────────────────────

/**
 * The three ways a clinical_lead earns owner-grade treatment, per the Phase 3
 * policy. Anything else keeps it at Tier C.
 */
export type Corroboration =
  | 'registry_officer'        // a state filing names them as an officer
  | 'serp_owner'              // a SERP result calls them owner/founder
  | 'sole_person_ownership'   // only person on the site, and it speaks in first person

export const CORROBORATIONS: Corroboration[] = [
  'registry_officer', 'serp_owner', 'sole_person_ownership',
]

export function promotesToOwner(corroboration: readonly string[]): boolean {
  return corroboration.some(c => (CORROBORATIONS as readonly string[]).includes(c))
}

/**
 * First-person ownership language on the business's own site.
 *
 * Deliberately narrow. "We are a team of experts" is marketing copy every site
 * has; "I opened this practice in 2015" is an ownership claim. Only the second
 * shape counts, and it only counts at all when exactly one person is named on
 * the site — one voice, one name, so the voice is that name's.
 */
const OWNERSHIP_VOICE_RE = new RegExp(
  [
    '\\bi (?:founded|opened|started|established|launched|created|built|own)\\b',
    '\\bmy (?:practice|clinic|spa|business|team|office|studio|salon|passion)\\b',
    '\\bi am the (?:owner|founder|proprietor)\\b',
    "\\bi'?m the (?:owner|founder|proprietor)\\b",
    '\\bwhen i (?:founded|opened|started|established)\\b',
    '\\bafter (?:years|\\d+ years) .{0,40}\\bi (?:opened|founded|started)\\b',
    '\\b(?:founded|opened|established) by\\b',
    '\\bowner and (?:operator|founder)\\b',
  ].join('|'),
  'i',
)

export function hasOwnershipVoice(siteText: string): boolean {
  return OWNERSHIP_VOICE_RE.test(siteText ?? '')
}

/**
 * The `sole_person_ownership` test: exactly one person named on the whole site,
 * and the site speaks with an owner's voice.
 *
 * The "exactly one" half is what makes this safe. A site listing six providers
 * plus "I founded this practice" gives no way to know which of the six is
 * speaking, and guessing would reintroduce the wrong-person failure the name
 * corroboration rule exists to stop.
 */
export function solePersonOwnership(peopleNamedOnSite: number, siteText: string): boolean {
  return peopleNamedOnSite === 1 && hasOwnershipVoice(siteText)
}
