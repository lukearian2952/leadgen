// Ported from v1 `supabase/functions/_shared/identity.ts`, unchanged in substance.
// This is the most valuable module in the old codebase: every classifier here
// exists because a specific class of garbage reached a customer's CSV.

// Who counts as an owner, what counts as their mailbox, and what a name is.
//
// The export that triggered this rework had 85% of rows with no first name and
// 43% pointing at info@ / hello@ / support@. Both failures came from the same
// place: the pipeline accepted whatever string an actor handed back and wrote it
// into whatever column was empty. Everything here is a hard classifier instead.

// ── Owner titles ─────────────────────────────────────────────────────────────

/**
 * Titles that make someone a decision-maker worth emailing. Extends the
 * original keyword list with the clinical-practice variants that dominate
 * wellness/medical niches, where the owner is usually "Dr. X, Medical Director"
 * rather than "CEO".
 */
export const OWNER_TITLE_RE = new RegExp(
  [
    'owner', 'owner-operator', 'founder', 'co-?founder', 'ceo', 'chief executive',
    'president', 'principal', 'managing director', 'managing partner', 'proprietor',
    'clinic director', 'medical director', 'practice owner', 'practice manager',
    'managing member', 'partner',
    'dr\\.?\\s',
  ].join('|'),
  'i',
)

export function isOwnerTitle(title = ''): boolean {
  return OWNER_TITLE_RE.test(title)
}

// ── Mailbox classification ───────────────────────────────────────────────────

/**
 * Role/shared inboxes. These reach a front desk, not a decision-maker, so they
 * may only ever land in `email` (the general inbox column) — never owner_email.
 */
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'hello', 'contact', 'admin', 'office', 'frontdesk', 'front-desk',
  'support', 'sales', 'reception', 'receptionist', 'team', 'booking', 'bookings',
  'appointments', 'appointment', 'care', 'concierge', 'help', 'mail', 'email',
  'billing', 'accounts', 'accounting', 'hr', 'jobs', 'careers', 'press', 'media',
  'marketing', 'customerservice', 'customer-service', 'customercare', 'service',
  'services', 'inquiries', 'enquiries', 'general', 'noreply', 'no-reply',
  'donotreply', 'newsletter', 'subscribe', 'webmaster', 'postmaster', 'abuse',
  'privacy', 'legal', 'orders', 'shop', 'store', 'spa', 'clinic', 'frontoffice',
  'schedule', 'scheduling', 'newpatients', 'patients', 'clients', 'welcome',
])

export function isGenericLocalPart(email: string): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  if (GENERIC_LOCAL_PARTS.has(local)) return true
  // "info.ny", "contact-us", "office2" — a generic stem with a suffix.
  const stem = local.replace(/[._-]?\d+$/, '').split(/[._-]/)[0]
  return GENERIC_LOCAL_PARTS.has(stem)
}

/**
 * Placeholder domains that ship inside website templates and CMS defaults. Real
 * businesses never receive mail here — these were 15 rows of pure noise in the
 * sample export (filler@godaddy.com, contact@mysite.com, mymail@mailservice.com).
 */
export const JUNK_DOMAINS = new Set([
  'godaddy.com', 'mysite.com', 'mailservice.com', 'example.com', 'example.org',
  'example.net', 'wixpress.com', 'wix.com', 'squarespace.com', 'sentry.io',
  'sentry-next.wixpress.com', 'domain.com', 'yourdomain.com', 'wordpress.com',
  'wordpress.org', 'email.com', 'test.com', 'localhost', 'yoursite.com',
  'company.com', 'website.com', 'mydomain.com', 'placeholder.com', 'acme.com',
  'businessname.com', 'yourcompany.com', 'sample.com', 'demo.com', 'site.com',
  'weebly.com', 'godaddysites.com', 'wixsite.com', 'shopify.com', 'myshopify.com',
  'cloudflare.com', 'jquery.com', 'w3.org', 'schema.org', 'gravatar.com',
])

export function isJunkDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  if (JUNK_DOMAINS.has(d)) return true
  // Subdomains of a junk host, e.g. foo.wixsite.com
  return [...JUNK_DOMAINS].some(j => d.endsWith(`.${j}`))
}

/** Consumer mailbox providers. Allowed only under the narrow rule in the gate. */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com',
  'fastmail.com', 'hushmail.com', 'tutanota.com', 'tuta.io', 'mail.ru',
  'qq.com', '163.com', '126.com', 'naver.com', 'hanmail.net', 'daum.net',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'earthlink.net', 'optonline.net', 'roadrunner.com',
  'rr.com', 'juno.com', 'netzero.net', 'frontier.com', 'windstream.net',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'telus.net', 'btinternet.com',
])

export function isFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase())
}

export function emailDomain(email: string): string {
  return (email.split('@')[1] ?? '').toLowerCase().trim()
}

export function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test((s ?? '').trim())
}

export function extractDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`)
      .hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return (url ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()
  }
}

// ── Names ────────────────────────────────────────────────────────────────────

const HONORIFICS = /^(dr|doctor|mr|mrs|ms|miss|mx|prof|professor|rev|sir|dame)\.?$/i
const DOCTOR_MARKERS = /\b(dr|doctor)\b\.?|,?\s*(m\.?d|d\.?o|d\.?d\.?s|d\.?m\.?d|d\.?c|n\.?d|o\.?d|d\.?p\.?m|ph\.?d)\b/i
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v|md|do|dds|dmd|dc|nd|od|dpm|phd|rn|np|pa|lmt|lac|cpa|esq|mba|facs|faap)\.?,?$/i

/**
 * Tokens that mean the string is an organisation, a department or a role rather
 * than a person. "Wellness Team", "Front Office", "The Smith Clinic" all came
 * through the old pipeline as owner names.
 */
const NON_PERSON_TOKENS = [
  'team', 'office', 'staff', 'clinic', 'center', 'centre', 'group', 'llc', 'inc',
  'corp', 'corporation', 'ltd', 'limited', 'pllc', 'pc', 'pa', 'spa', 'salon',
  'studio', 'associates', 'association', 'partners', 'department', 'dept',
  'management', 'services', 'solutions', 'company', 'co', 'institute', 'academy',
  'practice', 'wellness', 'health', 'medical', 'dental', 'clinic', 'care',
  'admin', 'support', 'reception', 'front', 'desk', 'billing', 'sales',
  'marketing', 'customer', 'client', 'contact', 'info', 'the', 'and',
  'owner', 'founder', 'director', 'manager', 'president', 'ceo', 'doctor',
]

const NON_PERSON_RE = new RegExp(`\\b(${NON_PERSON_TOKENS.join('|')})\\b`, 'i')

/** A single name token: letters, optionally with one internal hyphen/apostrophe. */
const NAME_TOKEN_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)?$/

export interface ParsedName {
  first: string
  last: string
  isDoctor: boolean
  /** Reject reason when the string is not a usable person name. */
  reject: string | null
}

/**
 * Split a raw name string into first/last.
 *
 * Deliberately conservative: anything that smells like a company, a role or a
 * department is rejected outright rather than half-parsed, because a wrong
 * first name is worse than no first name — it produces "Hi Wellness," mail.
 */
export function parseName(raw: string): ParsedName {
  const empty: ParsedName = { first: '', last: '', isDoctor: false, reject: null }
  const input = (raw ?? '').trim()
  if (!input) return { ...empty, reject: 'no_owner_name' }

  const isDoctor = DOCTOR_MARKERS.test(input)

  // Drop credential tails: "Jane Smith, MD, FACS" -> "Jane Smith"
  let cleaned = input.split(/[,|(]/)[0].trim()
  // Strip anything non-name-ish (digits, @, slashes) early.
  if (/[0-9@/\\]/.test(cleaned)) return { ...empty, isDoctor, reject: 'name_has_digits_or_symbols' }

  let tokens = cleaned.split(/\s+/).filter(Boolean)

  // Strip honorifics and suffixes.
  tokens = tokens.filter(t => !HONORIFICS.test(t) && !NAME_SUFFIX.test(t))
  if (!tokens.length) return { ...empty, isDoctor, reject: 'name_only_honorific' }

  // Reject organisations / roles / departments.
  if (NON_PERSON_RE.test(tokens.join(' '))) {
    return { ...empty, isDoctor, reject: 'name_not_a_person' }
  }
  // Four or more tokens is nearly always a business name.
  if (tokens.length > 3) return { ...empty, isDoctor, reject: 'name_too_many_tokens' }

  const valid = tokens.filter(t => NAME_TOKEN_RE.test(t))
  if (!valid.length) return { ...empty, isDoctor, reject: 'name_not_letters' }

  const first = valid[0]
  const last = valid.length > 1 ? valid[valid.length - 1] : ''

  if (first.length < 2 || first.length > 20) return { ...empty, isDoctor, reject: 'first_name_length' }

  return {
    first: titleCase(first),
    last: last ? titleCase(last) : '',
    isDoctor,
    reject: null,
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/** Gate rule 1, applied to an already-parsed first name. */
export function checkFirstName(first: string): string | null {
  if (!first) return 'no_owner_first_name'
  if (!NAME_TOKEN_RE.test(first)) return 'first_name_not_letters'
  if (first.length < 2 || first.length > 20) return 'first_name_length'
  if (NON_PERSON_RE.test(first)) return 'first_name_not_a_person'
  return null
}

// ── Pattern email construction ───────────────────────────────────────────────

const ASCII = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase()

/**
 * The six candidate shapes, in descending order of how common they are for
 * small owner-operated businesses. Order matters: the first Deliverable hit
 * wins, so a wrong-but-deliverable guess earlier in the list is a real risk —
 * which is exactly why catch-all domains are rejected instead of guessed at.
 */
export function candidateEmails(first: string, last: string, domain: string): string[] {
  const f = ASCII(first)
  const l = ASCII(last)
  if (!f || !domain) return []

  const out = [`${f}@${domain}`]
  if (l) {
    out.push(
      `${f}.${l}@${domain}`,
      `${f[0]}${l}@${domain}`,
      `${f}${l[0]}@${domain}`,
      `${f}_${l}@${domain}`,
      `${f[0]}.${l}@${domain}`,
    )
  }
  return [...new Set(out)]
}

/** A local-part that can never exist, used to detect catch-all domains. */
export function catchAllProbe(domain: string): string {
  const nonce = Math.random().toString(36).slice(2, 10)
  return `zz${nonce}nx@${domain}`
}

/**
 * Freemail is acceptable only when the business genuinely has no branded mail —
 * and even then only when the mailbox is personalised to the owner.
 */
export function freemailAllowed(
  email: string, first: string, last: string, websiteDomain: string,
): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase()
  const domain = emailDomain(email)
  if (!isFreemail(domain)) return true

  // "The whole business runs on freemail": no branded site, or the site itself
  // is on the same consumer provider.
  const businessOnFreemail = !websiteDomain || isFreemail(websiteDomain) || websiteDomain === domain
  if (!businessOnFreemail) return false

  const f = ASCII(first)
  const l = ASCII(last)
  const flat = local.replace(/[^a-z]/g, '')
  return !!(f && flat.includes(f)) || !!(l && l.length > 2 && flat.includes(l))
}
