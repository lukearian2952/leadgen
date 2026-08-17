// registry:match — find this business in a state registry and take its officer.
//
// ── Why this stage exists ────────────────────────────────────────────────────
//
// The Phase 2 audit found the naming wall was not crawl coverage but the title
// gate: 21 of 75 leads had a person extracted from their own site and were
// rejected because "board-certified Nurse Practitioner" is not an ownership
// claim. A registry officer is an ownership claim by construction — it is what
// the business told the state.
//
// ── Matching ─────────────────────────────────────────────────────────────────
//
// Key: normalised name + county, trigram similarity ≥ 0.6, ZIP/street as
// tie-break.
//
// County rather than city because NY's `location_city` is 8.3% populated while
// `county` is 100%. But a Google Maps business has a ZIP and a town, never a
// county — hence the `zip_county` crosswalk, built from the registry's own
// (zip, county) pairs during ingest.
//
// The 0.6 floor is where the brief puts it and it is not generous.
// "Radiance Med Spa" against "RADIANCE MEDICAL AESTHETICS LLC" normalises to
// "radiance med spa" vs "radiance medical aesthetics", which scores well under
// it. DBA and trade names are absent from these datasets entirely, so that
// business is simply unmatchable — a real ceiling, not a tuning problem.

import type { Task } from 'graphile-worker'
import { wrapTask, jobKey, type JobContext } from './wrap.js'
import type { TaskDeps } from './index.js'
import { adapterFor, upsertEntities, type IngestScope } from '../sources/registry/index.js'
import type { RegistryOfficer } from '../sources/registry/types.js'
import { distinctiveTokens } from '../lib/normalise.js'
import { longIslandCounty } from '../lib/long-island.js'
import { putCandidates, applyNameDecision, serpWouldHelp } from './name-store.js'
import type { NameCandidate } from '../lib/name-decision.js'

interface Payload { campaignId: string; leadId: string; [key: string]: unknown }

/** The brief's floor. Below this, a "match" is two businesses sharing a word. */
export const MIN_SIMILARITY = 0.6

interface LeadRow {
  id: string
  business_name: string
  state: string
  city: string
  county: string
  name_norm: string
  postal_code: string
  street: string
}

interface MatchRow {
  id: string
  name: string
  county: string
  postal_code: string
  street: string
  officers: RegistryOfficer[]
  sim: string
}

export function makeRegistryMatchTask(deps: TaskDeps): Task {
  const { config, db } = deps

  return wrapTask<Payload>({ stage: 'registry:match', db }, async (payload, ctx) => {
    const { campaignId, leadId } = payload

    const { rows } = await db.query<LeadRow>(
      `select l.id, l.business_name, coalesce(nullif(l.state,''), b.state, '') state,
              coalesce(nullif(l.city,''), b.city, '') city,
              coalesce(nullif(l.county,''), b.county, '') county,
              coalesce(b.name_norm, '') name_norm,
              coalesce(b.postal_code, '') postal_code,
              coalesce(b.street, '') street
         from leads l left join businesses b on b.id = l.business_id
        where l.id = $1`, [leadId])
    const lead = rows[0]
    if (!lead) { ctx.logger.warn('lead vanished'); return }

    const state = normaliseState(lead.state)
    const county = await resolveCounty(db, lead, state)
    const nameNorm = lead.name_norm || lead.business_name.toLowerCase()

    if (!state || !nameNorm) {
      ctx.cost.detail = { matched: false, reason: 'no_state_or_name' }
      await putCandidates(db, leadId, 'registry', [])
      return finishStage(ctx, db, campaignId, leadId)
    }

    // ── local match ───────────────────────────────────────────────────────────
    let best = await bestMatch(db, state, county, nameNorm, lead)
    let toppedUp = false

    // ── top-up ────────────────────────────────────────────────────────────────
    // The bulk slice is scoped by niche keywords, which are a guess about how
    // businesses name themselves. One targeted request on this business's own
    // distinctive tokens makes coverage independent of that guess.
    if (!best) {
      const adapter = adapterFor(state, config, ctx.logger)
      const tokens = distinctiveTokens(lead.business_name)
      if (adapter?.lookup && tokens.length) {
        toppedUp = true
        const scope: IngestScope = { counties: county ? [county] : [], limit: 200 }
        const fetched = []
        for await (const entity of adapter.lookup(tokens, scope)) fetched.push(entity)
        if (fetched.length) {
          await upsertEntities(db, fetched)
          best = await bestMatch(db, state, county, nameNorm, lead)
        }
        ctx.logger.info('registry top-up lookup', {
          tokens, county, fetched: fetched.length, matched: Boolean(best),
        })
      }
    }

    if (!best) {
      await putCandidates(db, leadId, 'registry', [])
      ctx.cost.detail = {
        matched: false, state, county: county || null,
        topped_up: toppedUp, reason: 'no_entity_above_threshold',
      }
      return finishStage(ctx, db, campaignId, leadId)
    }

    // ── officer ───────────────────────────────────────────────────────────────
    // Officers arrive pre-sorted by the adapter's field priority (NY: brief
    // order dos_process_name → chairman → registered agent; FL: owner-grade
    // title codes first). The first person is the answer.
    const officer = (best.officers ?? []).find(o => o.kind === 'person' && o.first)
    const confidence = Number(best.sim)

    const candidates: NameCandidate[] = officer ? [{
      source: 'registry',
      first: officer.first,
      last: officer.last,
      title: officer.title,
      // A registry officer is owner-grade by construction: it is what the
      // business told the state about who runs it.
      nameClass: 'owner_grade',
      confidence,
      detail: {
        registry_state: state,
        entity_name: best.name,
        entity_id: best.id,
        source_field: officer.source_field,
        raw_name: officer.name,
        similarity: confidence,
      },
    }] : []

    await putCandidates(db, leadId, 'registry', candidates)
    await db.query(
      `update leads set registry_entity_id = $2, match_confidence = $3,
                        county = coalesce(nullif(county,''), $4)
        where id = $1`,
      [leadId, best.id, confidence, county])

    ctx.cost.detail = {
      matched: true, state, county: county || null, topped_up: toppedUp,
      similarity: confidence, entity_name: best.name,
      named: Boolean(officer),
      source_field: officer?.source_field ?? null,
    }

    return finishStage(ctx, db, campaignId, leadId)
  })
}

/**
 * Similarity floor for a business whose name is *entirely* niche words.
 * See the note below on why 0.6 is not safe for those.
 */
export const GENERIC_NAME_MIN_SIMILARITY = 0.9

/**
 * Best registry entity for this business.
 *
 * `name_norm % $2` is the index-accelerated trigram operator, so the GIN index
 * does the filtering; the explicit `similarity() >= 0.6` then applies the
 * brief's threshold, which is above pg_trgm's 0.3 default. Ordering puts an
 * exact-ZIP entity ahead of a slightly better-scoring one elsewhere, since two
 * businesses of similar name in one county are usually distinguished by
 * address rather than by spelling.
 *
 * ── Why trigram similarity alone is not enough ───────────────────────────────
 *
 * Measured on these exact 75 businesses before this guard existed. Trigram
 * similarity ≥ 0.6 produced confident matches that are simply different
 * companies, because every name in a niche shares most of its words:
 *
 *   AIREM Aesthetic Spa & Plastic Surgery → AESTHETIC PLASTIC SURGERY, P.C.  0.75
 *   Haven Aesthetics & Laser              → LUXE LASER & AESTHETICS INC      0.63
 *   Simplyme Aesthetics + Wellness        → CLA AESTHETICS & WELLNESS LLC    0.61
 *   Laser Spa Studio                      → DG LASER STUDIO LLC              0.68
 *   Med Spa                               → INJX MED SPA, LLC                0.62
 *
 * Each would have attached a **real person's name to the wrong business** —
 * strictly worse than no name, and the precise failure the corroboration rules
 * exist to prevent. "aesthetic", "spa", "laser", "wellness" are 60% of the
 * characters in both strings, so similarity measures the niche, not the
 * business.
 *
 * Two guards, and a match must clear whichever applies:
 *
 *   * The business name has a distinctive (non-niche) token — "airem",
 *     "haven", "simplyme", "brizel" — and the entity name must contain one of
 *     them. This alone rejects all three of the wrong matches above.
 *   * The business name has *no* distinctive token at all ("Med Spa", "Laser
 *     Spa Studio", "The Skin Studio"). Then nothing about the name can
 *     identify it, so the bar rises to near-exact similarity **and** a matching
 *     ZIP. That rejects the remaining two.
 */
async function bestMatch(
  db: TaskDeps['db'], state: string, county: string, nameNorm: string, lead: LeadRow,
): Promise<MatchRow | null> {
  const tokens = distinctiveTokens(lead.business_name, 3)
    .filter(t => !GENERIC_FALLBACK.has(t))

  const params: unknown[] = [state, nameNorm, county, MIN_SIMILARITY, lead.postal_code]
  let guard: string

  if (tokens.length) {
    // `like` rather than another trigram op: this is a containment test on an
    // already-narrowed candidate set, not a ranking.
    const clauses = tokens.map(t => {
      params.push(`%${t}%`)
      return `name_norm like $${params.length}`
    })
    guard = `(${clauses.join(' or ')})`
  } else {
    params.push(GENERIC_NAME_MIN_SIMILARITY)
    const simParam = `$${params.length}`
    guard =
      `similarity(name_norm, $2) >= ${simParam}
       and left(regexp_replace(postal_code,'[^0-9]','','g'),5)
         = left(regexp_replace($5,'[^0-9]','','g'),5)
       and $5 <> ''`
  }

  const { rows } = await db.query<MatchRow>(
    `select id, name, county, postal_code, street, officers,
            similarity(name_norm, $2)::text sim
       from registry_entities
      where state = $1
        and ($3 = '' or county = '' or county = $3)
        and name_norm % $2
        and similarity(name_norm, $2) >= $4
        and ${guard}
      order by (left(regexp_replace(postal_code,'[^0-9]','','g'),5)
                 = left(regexp_replace($5,'[^0-9]','','g'),5)) desc,
               (officers <> '[]'::jsonb) desc,
               similarity(name_norm, $2) desc
      limit 5`,
    params)
  return rows[0] ?? null
}

/**
 * Tokens `distinctiveTokens` falls back to when a name has nothing
 * distinctive in it. They are excluded here so the fallback cannot be mistaken
 * for a real discriminator — "studio" matched "Laser Spa Studio" to "DG LASER
 * STUDIO LLC", which is a different company.
 */
const GENERIC_FALLBACK = new Set([
  'spa', 'med', 'medi', 'skin', 'studio', 'laser', 'salon', 'beauty', 'body',
  'face', 'glow', 'care', 'health', 'medical', 'wellness', 'clinic', 'center',
  'aesthetic', 'aesthetics', 'lounge', 'day',
])

/**
 * A county for a business that only has a town and a ZIP.
 *
 * Registry-derived crosswalk first — it maps a ZIP to the county the state
 * itself files it under, which is the county we are about to match against.
 * The Long Island town list is the local fallback and exists because it was
 * already built and measured (75/75 on the Phase 2 run).
 *
 * Returning '' is not a failure: `bestMatch` treats an unknown county as "any",
 * trading precision for recall rather than dropping the lead.
 */
async function resolveCounty(
  db: TaskDeps['db'], lead: LeadRow, state: string,
): Promise<string> {
  if (lead.county) return lead.county
  if (lead.postal_code && state) {
    const { rows } = await db.query<{ county: string | null }>(
      `select county_for_zip($1,$2) county`, [lead.postal_code, state])
    if (rows[0]?.county) return rows[0].county
  }
  if (state === 'NY') {
    const li = longIslandCounty(lead.city)
    if (li) return li
  }
  return ''
}

function normaliseState(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(s)) return s
  const byName: Record<string, string> = {
    'NEW YORK': 'NY', FLORIDA: 'FL', COLORADO: 'CO',
  }
  return byName[s] ?? ''
}

/** Decide the name so far, then either buy a SERP lookup or move to enrich. */
async function finishStage(
  ctx: JobContext, db: TaskDeps['db'], campaignId: string, leadId: string,
): Promise<void> {
  const decision = await applyNameDecision(db, leadId)

  if (serpWouldHelp(decision)) {
    await ctx.helpers.addJob('serp:owner', { campaignId, leadId },
      { jobKey: jobKey('serp:owner', campaignId, leadId), maxAttempts: 2 })
    return
  }

  await ctx.helpers.addJob('enrich:lead', { campaignId, leadId },
    { jobKey: jobKey('enrich:lead', campaignId, leadId), maxAttempts: 3 })
}
