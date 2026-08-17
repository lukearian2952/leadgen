// Which of the collected names becomes the lead's owner, and why.
//
// Three stages propose candidates — the site crawl, the state registry, and
// SERP — and they disagree. This is the single place that resolves them, kept
// pure so the policy is testable without a database.
//
// ── The policy, per the Phase 3 brief ────────────────────────────────────────
//
// Source precedence: **registry → site → SERP**. A registry officer is an
// assertion made to a state under penalty of perjury; a site byline is
// marketing copy; a SERP hit is a third party's summary of one of the other
// two.
//
// Usability, which is applied *before* precedence:
//
//   owner_grade    usable alone.
//   clinical_lead  usable only with at least one corroboration —
//                  registry_officer, serp_owner, or sole_person_ownership.
//   staff          never usable.
//
// Order matters: an uncorroborated clinical_lead from the registry does not
// beat an owner_grade name from the site, because it is not a candidate at all.
// Precedence ranks the survivors, it does not admit anyone.

import { promotesToOwner, type NameClass, type Corroboration } from './name-class.js'

export type NameSource = 'registry' | 'site_crawl' | 'serp'

/** Registry first, then site, then SERP. Lower wins. */
const SOURCE_RANK: Record<NameSource, number> = {
  registry: 1,
  site_crawl: 2,
  serp: 3,
}

export interface NameCandidate {
  source: NameSource
  first: string
  last: string
  title: string
  nameClass: NameClass
  /** Source-specific: trigram similarity for registry, model confidence for SERP. */
  confidence?: number
  /** Free-form provenance for the evidence trail — the URL, the entity id. */
  detail?: Record<string, unknown>
}

export interface NameDecision {
  chosen: NameCandidate | null
  /** Why nothing was chosen, when nothing was. */
  reason: string
  /** Corroborations found for the chosen candidate. */
  corroboration: Corroboration[]
  /** Was a clinical_lead admitted by corroboration? Reported per the brief. */
  promoted: boolean
  /** Every candidate with its verdict, for the audit trail. */
  considered: Array<NameCandidate & { usable: boolean; corroboration: Corroboration[] }>
}

/**
 * Do two candidates refer to the same person?
 *
 * Last name plus first initial, not full equality. The registry has
 * "Iqbal, Uzma", the site has "Uzma Iqbal", and SERP has "Dr. U. Iqbal" — the
 * same human, spelled three ways. Requiring exact first names would score them
 * as three people and corroborate nothing.
 *
 * Last name alone is deliberately not enough: at a family practice the owner
 * and a staff member frequently share one.
 */
export function samePerson(a: NameCandidate, b: NameCandidate): boolean {
  const lastA = a.last.toLowerCase().trim()
  const lastB = b.last.toLowerCase().trim()
  if (!lastA || !lastB || lastA !== lastB) return false

  const firstA = a.first.toLowerCase().trim()
  const firstB = b.first.toLowerCase().trim()
  if (!firstA || !firstB) return true
  return firstA === firstB || firstA[0] === firstB[0]
}

export interface SiteSignals {
  /** How many distinct people the crawl named on the whole site. */
  peopleNamedOnSite: number
  /** Did the site speak with an owner's voice? */
  ownershipVoice: boolean
}

/**
 * Which independent sources corroborate this candidate.
 *
 * A source never corroborates itself: two registry columns naming the same
 * person is one filing agreeing with itself, not two sources agreeing.
 */
export function corroborationsFor(
  candidate: NameCandidate,
  all: readonly NameCandidate[],
  site: SiteSignals,
): Corroboration[] {
  const found = new Set<Corroboration>()

  for (const other of all) {
    if (other === candidate) continue
    if (other.source === candidate.source) continue
    if (!samePerson(candidate, other)) continue

    if (other.source === 'registry') found.add('registry_officer')
    // A SERP hit only corroborates ownership if it actually said "owner" or
    // "founder". A SERP result that merely repeats the clinical title adds no
    // information the site did not already have.
    if (other.source === 'serp' && other.nameClass === 'owner_grade') found.add('serp_owner')
  }

  // The sole-person test applies to the person the site itself names. It is
  // the site's own voice, so it cannot vouch for a name the site never
  // mentioned.
  if (candidate.source === 'site_crawl' && site.peopleNamedOnSite === 1 && site.ownershipVoice) {
    found.add('sole_person_ownership')
  }

  return [...found]
}

export function decideName(
  candidates: readonly NameCandidate[],
  site: SiteSignals,
): NameDecision {
  const considered = candidates.map(c => {
    const corroboration = corroborationsFor(c, candidates, site)
    const usable =
      c.nameClass === 'owner_grade' ||
      (c.nameClass === 'clinical_lead' && promotesToOwner(corroboration))
    return { ...c, usable, corroboration }
  })

  const usable = considered.filter(c => c.usable)
  if (!usable.length) {
    const hadClinical = considered.some(c => c.nameClass === 'clinical_lead')
    return {
      chosen: null,
      reason: considered.length === 0
        ? 'no_owner_first_name'
        : hadClinical
          ? 'clinical_lead_uncorroborated'
          : 'no_owner_grade_name',
      corroboration: [],
      promoted: false,
      considered,
    }
  }

  usable.sort((a, b) => {
    const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    if (rank !== 0) return rank
    // Within a source, the better-corroborated candidate, then the more
    // confident one. Both are stable tie-breaks; neither crosses sources.
    if (a.corroboration.length !== b.corroboration.length) {
      return b.corroboration.length - a.corroboration.length
    }
    return (b.confidence ?? 0) - (a.confidence ?? 0)
  })

  const winner = usable[0]
  return {
    chosen: {
      source: winner.source, first: winner.first, last: winner.last,
      title: winner.title, nameClass: winner.nameClass,
      confidence: winner.confidence, detail: winner.detail,
    },
    reason: '',
    corroboration: winner.corroboration,
    promoted: winner.nameClass === 'clinical_lead',
    considered,
  }
}
