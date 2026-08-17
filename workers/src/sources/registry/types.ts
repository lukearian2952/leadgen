// The shape every state registry adapter produces, and the scope it is asked for.
//
// Adapters differ enormously — NY is a Socrata API with three loosely-typed
// name columns, CO is a Socrata API with structured agent first/last names, FL
// is a 1.8 GB fixed-width SFTP drop with six typed officer slots — so the
// interface is deliberately narrow: given a scope, yield normalised entities.
// Everything state-specific, including the person-vs-company decision, happens
// inside the adapter.

import type { RegistryNameKind } from '../../lib/registry-name.js'

export interface RegistryOfficer {
  /** Verbatim, as the registry wrote it. Kept for the evidence trail. */
  name: string
  title: string
  first: string
  last: string
  kind: RegistryNameKind
  /** Which column this came from — `dos_process_name`, `officer_1`, … */
  source_field: string
  /** Lower is better. Drives which officer a match reports. */
  rank: number
}

export interface RegistryEntity {
  /** Registry's own state, e.g. 'NY'. Not the address state. */
  state: string
  entityId: string
  name: string
  nameNorm: string
  status: string
  entityType: string
  county: string
  city: string
  stateCode: string
  postalCode: string
  street: string
  /** ISO date, or null when the registry gives none. */
  filingDate: string | null
  officers: RegistryOfficer[]
  raw: Record<string, unknown>
}

export interface IngestScope {
  /** Counties as the registry spells them ('Nassau'), not as USPS does. */
  counties?: string[]
  /**
   * Substrings to require in the entity name. Case-insensitive. An empty list
   * means "no name filter", which for NY is 4.27M rows — always pass something.
   */
  nameContains?: string[]
  /** Hard ceiling on rows pulled, so a bad scope cannot run away. */
  limit?: number
}

export interface RegistryAdapter {
  /** Two-letter code. Matches `registry_entities.state`. */
  readonly state: string
  readonly name: string
  /** Yields entities for the scope. May be slow; callers stream it. */
  ingest(scope: IngestScope): AsyncIterable<RegistryEntity>
  /**
   * Targeted lookup for one business that the bulk slice missed. Bounded to a
   * single upstream request. Adapters that cannot do this cheaply (FL, whose
   * unit of access is a 1.8 GB archive) return an empty iterable.
   */
  lookup?(nameTokens: string[], scope: IngestScope): AsyncIterable<RegistryEntity>
}
