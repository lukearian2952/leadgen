// Regression checks built from the 468-lead "Wellness New York" export that
// motivated the gate. Every case here is something that export actually
// contained and shipped. Run with: deno test --allow-net _shared/gate_test.ts
//
// Network is only needed by the geo module's AI fallback, which these cases
// never reach — every location below resolves from the static tables.

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { evaluateGate, type GateLead } from './gate.ts'
import { resolveLocationScope } from './geo.ts'
import { resolveNicheFilter } from './niche-types.ts'
import { parseName, isGenericLocalPart, isJunkDomain, freemailAllowed, candidateEmails } from './identity.ts'

const scope = await resolveLocationScope('New York')
const niche = resolveNicheFilter('wellness')

function lead(over: Partial<GateLead> = {}): GateLead {
  // A row that passes everything, so each test changes exactly one thing.
  return {
    owner_first_name: 'Jane', owner_last_name: 'Sodol',
    owner_email: 'jane@berejuved.com', email: '',
    website: 'https://berejuved.com',
    state: 'NY', country: 'US', formatted_address: '1 Main St, Great Neck, NY',
    place_types: ['spa', 'health'], business_status: 'OPERATIONAL',
    mx_ok: true, domain_catch_all: false,
    email_status: 'deliverable', email_verifalia_status: 'Success',
    pending_verify: false,
    ...over,
  }
}

const check = (l: GateLead) => evaluateGate(l, { scope, niche })

Deno.test('the known-good row passes', () => {
  assertEquals(check(lead()), { pass: true, reason: '' })
})

Deno.test('rule 4: businesses outside the requested state are rejected', () => {
  // Troy MI, East Bay CA, Grand Bahama and Canada all shipped in the real export.
  assertEquals(check(lead({ state: 'MI', formatted_address: 'Troy, MI' })).reason, 'state_mismatch:MI')
  assertEquals(check(lead({ state: 'CA', formatted_address: 'Oakland, CA' })).reason, 'state_mismatch:CA')
  assertEquals(check(lead({ state: '', country: 'BS' })).reason, 'country_mismatch:BS')
  assertEquals(check(lead({ state: 'ON', country: 'CA' })).reason, 'country_mismatch:CA')
})

Deno.test('rule 4: non-US ccTLDs contradicting the scope are rejected', () => {
  assert(check(lead({ website: 'https://spa.co.uk' })).reason.startsWith('domain_cctld_mismatch'))
  assert(check(lead({ website: 'https://spa.ca' })).reason.startsWith('domain_cctld_mismatch'))
})

Deno.test('rule 5: business types outside the niche are rejected', () => {
  assert(check(lead({ place_types: ['restaurant'] })).reason.startsWith('type_mismatch'))
  assert(check(lead({ place_types: ['car_repair'] })).reason.startsWith('type_mismatch'))
  // Generic types carry no signal and must not count as a match.
  assertEquals(check(lead({ place_types: ['point_of_interest', 'establishment'] })).reason, 'no_place_types')
  // Legitimate wellness types still pass.
  assertEquals(check(lead({ place_types: ['beauty_salon'] })).pass, true)
})

Deno.test('closed businesses are rejected', () => {
  assertEquals(check(lead({ business_status: 'CLOSED_PERMANENTLY' })).reason, 'business_closed_permanently')
})

Deno.test('rule 2: role inboxes never reach the export', () => {
  // 43% of the real export was these.
  for (const e of ['info@x.com', 'hello@x.com', 'support@x.com', 'frontdesk@x.com', 'booking@x.com', 'info.ny@x.com']) {
    assertEquals(check(lead({ owner_email: e })).reason, 'owner_email_is_role_inbox', e)
  }
})

Deno.test('rule 3: placeholder domains are rejected', () => {
  // The 15 literal placeholders from the export.
  for (const e of ['filler@godaddy.com', 'contact@mysite.com', 'mymail@mailservice.com']) {
    const r = check(lead({ owner_email: e })).reason
    assert(r.startsWith('junk_email_domain') || r === 'owner_email_is_role_inbox', `${e} -> ${r}`)
  }
  assert(isJunkDomain('wixpress.com') && isJunkDomain('foo.wixsite.com') && isJunkDomain('yourdomain.com'))
  assert(check(lead({ website: 'https://mysite.com' })).reason.startsWith('junk_domain'))
})

Deno.test('rule 3: no MX means unreachable', () => {
  assertEquals(check(lead({ mx_ok: false })).reason, 'no_mx')
  // An unresolvable lookup fails the row but is reported distinctly.
  assertEquals(check(lead({ mx_ok: null })).reason, 'mx_unknown')
})

Deno.test('rule 2: only exactly-Deliverable survives', () => {
  assertEquals(check(lead({ email_status: 'risky' })).reason, 'not_deliverable:risky')
  assertEquals(check(lead({ email_status: 'unknown' })).reason, 'not_deliverable:unknown')
  assertEquals(check(lead({ email_status: '' })).reason, 'not_deliverable:unverified')
  assertEquals(check(lead({ domain_catch_all: true })).reason, 'catch_all_domain')
  assertEquals(check(lead({ email_verifalia_status: 'ServerIsCatchAll' })).reason, 'catch_all_domain')
  assertEquals(check(lead({ pending_verify: true })).reason, 'pending_verify')
})

Deno.test('rule 2: freemail only when the business runs on freemail AND it is personalised', () => {
  // Branded site + gmail owner address: rejected.
  assertEquals(
    check(lead({ owner_email: 'jane.sodol@gmail.com' })).reason,
    'freemail:gmail.com',
  )
  // No branded site at all, and the local part carries the owner's name: allowed.
  assert(freemailAllowed('janesodol@gmail.com', 'Jane', 'Sodol', ''))
  // No branded site but an anonymous mailbox: not allowed.
  assert(!freemailAllowed('nycmedspa2021@gmail.com', 'Jane', 'Sodol', ''))
})

Deno.test('rule 1: a full name never lands in the first-name field', () => {
  // "Never write 'Lily Doran' into a first-name field."
  const p = parseName('Lily Doran')
  assertEquals(p.first, 'Lily')
  assertEquals(p.last, 'Doran')
  assertEquals(check(lead({ owner_first_name: 'Lily Doran' })).reason, 'first_name_not_letters')
})

Deno.test('rule 1: companies, roles and departments are not people', () => {
  for (const s of [
    'Wellness Team', 'Front Office', 'The Smith Clinic', 'Radiance Med Spa LLC',
    'Our Team', 'Owner', 'Practice Manager', 'Customer Support',
  ]) {
    assert(parseName(s).reject !== null, `${s} should be rejected, got ${JSON.stringify(parseName(s))}`)
  }
})

Deno.test('rule 1: honorifics are stripped but the doctor flag survives', () => {
  const p = parseName('Dr. Sarah Bonner')
  assertEquals(p.first, 'Sarah')
  assertEquals(p.last, 'Bonner')
  assertEquals(p.isDoctor, true)

  const q = parseName('Sarah Bonner, MD, FACS')
  assertEquals(q.first, 'Sarah')
  assertEquals(q.last, 'Bonner')
  assertEquals(q.isDoctor, true)
})

Deno.test('email pattern construction covers the six shapes, deduped', () => {
  const c = candidateEmails('Sarah', 'Bonner', 'treatmedspa.com')
  assertEquals(c, [
    'sarah@treatmedspa.com',
    'sarah.bonner@treatmedspa.com',
    'sbonner@treatmedspa.com',
    'sarahb@treatmedspa.com',
    'sarah_bonner@treatmedspa.com',
    's.bonner@treatmedspa.com',
  ])
  // No last name: only the one shape that makes sense.
  assertEquals(candidateEmails('Sarah', '', 'x.com'), ['sarah@x.com'])
  // Accents are folded rather than producing an invalid local part.
  assertEquals(candidateEmails('José', 'Núñez', 'x.com')[0], 'jose@x.com')
})

Deno.test('generic local-part detection catches suffixed stems', () => {
  assert(isGenericLocalPart('info@x.com'))
  assert(isGenericLocalPart('office2@x.com'))
  assert(isGenericLocalPart('contact-us@x.com'))
  assert(!isGenericLocalPart('sarah@x.com'))
  assert(!isGenericLocalPart('sarah.bonner@x.com'))
})

Deno.test('an unresolvable location disables rule 4 rather than emptying the export', () => {
  const unscoped = { stateCodes: [], countryCodes: [], source: 'unscoped' as const }
  const verdict = evaluateGate(lead({ state: 'MI', country: 'US' }), { scope: unscoped, niche })
  assertEquals(verdict.pass, true)
})

Deno.test('an unmatched niche disables rule 5 rather than emptying the export', () => {
  const noNiche = resolveNicheFilter('artisanal widget consultancy')
  assertEquals(noNiche.active, false)
  assertEquals(evaluateGate(lead({ place_types: ['restaurant'] }), { scope, niche: noNiche }).pass, true)
})
