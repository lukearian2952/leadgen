// Where naming candidates live between stages, and the single writer that
// turns them into the lead's owner.
//
// Three stages propose names at three different times — crawl:site, then
// registry:match, then serp:owner — and none of them can see the others'
// findings in memory. Candidates accumulate in `leads.evidence.name_candidates`
// and the decision is re-derived from the whole set whenever it changes, so the
// outcome does not depend on which stage happened to finish last.
//
// `evidence` is jsonb and every writer merges with `||`, so appending here
// cannot clobber the crawl's page list or the verifier's detail.

import type { Pool } from 'pg'
import { decideName, type NameCandidate, type NameDecision, type SiteSignals } from '../lib/name-decision.js'

export interface StoredNameState {
  candidates: NameCandidate[]
  site: SiteSignals
}

export async function readNameState(db: Pool, leadId: string): Promise<StoredNameState> {
  const { rows } = await db.query<{ evidence: Record<string, unknown> | null; business_name: string }>(
    `select evidence, business_name from leads where id = $1`, [leadId])
  const evidence = rows[0]?.evidence ?? {}
  return {
    candidates: (evidence.name_candidates as NameCandidate[] | undefined) ?? [],
    site: {
      peopleNamedOnSite: Number(evidence.site_people_count ?? 0),
      ownershipVoice: Boolean(evidence.site_ownership_voice),
      // The name-in-business-name rule needs it, and it is on the row already.
      businessName: rows[0]?.business_name ?? '',
    },
  }
}

/**
 * Append candidates for one source, replacing any this source added before.
 *
 * Replace-by-source rather than append-only because a job can be retried: a
 * `registry:match` that runs twice must not make the registry look like two
 * agreeing sources, which would corroborate a clinical_lead out of thin air.
 */
export async function putCandidates(
  db: Pool, leadId: string, source: NameCandidate['source'], candidates: NameCandidate[],
): Promise<NameCandidate[]> {
  const state = await readNameState(db, leadId)
  const merged = [...state.candidates.filter(c => c.source !== source), ...candidates]
  await db.query(
    `update leads set evidence = evidence || jsonb_build_object('name_candidates', $2::jsonb)
      where id = $1`,
    [leadId, JSON.stringify(merged)])
  return merged
}

/** Record the two site-level signals the sole-person corroboration needs. */
export async function putSiteSignals(
  db: Pool, leadId: string, site: SiteSignals,
): Promise<void> {
  await db.query(
    `update leads set evidence = evidence || jsonb_build_object(
        'site_people_count', $2::int, 'site_ownership_voice', $3::boolean)
      where id = $1`,
    [leadId, site.peopleNamedOnSite, site.ownershipVoice])
}

/**
 * Resolve the candidates and write the result onto the lead.
 *
 * Idempotent: it recomputes from the stored candidates every time, so calling
 * it after registry and again after SERP is correct rather than merely safe.
 */
export async function applyNameDecision(db: Pool, leadId: string): Promise<NameDecision> {
  const state = await readNameState(db, leadId)
  const decision = decideName(state.candidates, state.site)
  const chosen = decision.chosen

  await db.query(
    `update leads
        set owner_first_name = $2, owner_last_name = $3,
            owner_name  = $4, title = $5,
            owner_source = $6, name_class = $7,
            corroboration = $8::text[],
            name_done = true,
            sources = array(select distinct unnest(sources || $9::text[])),
            evidence = evidence || jsonb_build_object(
              'name_decision', $10::jsonb)
      where id = $1`,
    [
      leadId,
      chosen?.first ?? '',
      chosen?.last ?? '',
      chosen ? [chosen.first, chosen.last].filter(Boolean).join(' ') : '',
      chosen?.title ?? '',
      chosen?.source ?? '',
      chosen?.nameClass ?? '',
      decision.corroboration,
      chosen ? [chosen.source] : [],
      JSON.stringify({
        reason: decision.reason,
        promoted_clinical_lead: decision.promoted,
        corroboration: decision.corroboration,
        considered: decision.considered.map(c => ({
          source: c.source, name: [c.first, c.last].filter(Boolean).join(' '),
          title: c.title, name_class: c.nameClass, usable: c.usable,
          corroboration: c.corroboration, confidence: c.confidence ?? null,
        })),
      }),
    ])

  return decision
}

/**
 * Is SERP worth spending on this lead?
 *
 * Two cases, and only two. Everything else already has a usable name, and a
 * SERP call that cannot change the outcome is a Haiku call and a residential
 * request bought for nothing.
 */
export function serpWouldHelp(decision: NameDecision): boolean {
  // Nothing usable yet — SERP might find the owner outright.
  if (!decision.chosen) return true
  // A clinical_lead that got in on `sole_person_ownership` alone is the weakest
  // admission the policy allows; a SERP owner hit would make it a real one.
  if (decision.chosen.nameClass === 'clinical_lead' &&
      decision.corroboration.length === 1 &&
      decision.corroboration[0] === 'sole_person_ownership') return true
  return false
}
