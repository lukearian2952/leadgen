// Anthropic calls for the owner-lookup stage.
//
// Raw fetch rather than the SDK, to match how expandLocation already calls the
// API from owner-patterns.ts — mixing an SDK client and a hand-rolled fetch
// against the same provider in the same shared directory is worse than either.
//
// Every call here uses structured outputs (`output_config.format`), so the
// model returns JSON that already conforms to the schema. The old pattern —
// "respond with ONLY a JSON array" plus JSON.parse in a try/catch — silently
// yielded nothing whenever the model added a sentence of preamble.

const API_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Haiku 4.5 is the right tier here: the work is extraction from a page of
 * text, not reasoning. Note it does NOT accept `output_config.effort` — sending
 * one is an error — so this module never sets it.
 */
export const MODEL = 'claude-haiku-4-5-20251001'

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  calls: number
}

export interface LlmResult<T> {
  data: T | null
  usage: LlmUsage
  error: string | null
}

const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
}

/**
 * One structured-output call. Returns null data on any failure — callers treat
 * a null as "this strategy found nothing" and fall through to the next one.
 */
export async function askJson<T>(
  apiKey: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxTokens = 1024,
): Promise<LlmResult<T>> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { data: null, usage: { ...EMPTY_USAGE, calls: 1 }, error: `HTTP ${res.status} ${body.slice(0, 200)}` }
    }

    const json = await res.json() as AnthropicResponse
    const usage: LlmUsage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      calls: 1,
    }

    // A truncated response is not valid JSON no matter what the schema says.
    if (json.stop_reason === 'max_tokens') {
      return { data: null, usage, error: 'response truncated at max_tokens' }
    }

    const text = json.content?.find(b => b.type === 'text')?.text
      ?? json.content?.[0]?.text ?? ''
    if (!text.trim()) return { data: null, usage, error: 'empty response' }

    return { data: JSON.parse(text) as T, usage, error: null }
  } catch (err) {
    return {
      data: null,
      usage: { ...EMPTY_USAGE, calls: 1 },
      error: (err as Error).message,
    }
  }
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
  }
}

export const zeroUsage = (): LlmUsage => ({ ...EMPTY_USAGE })

// ── Schemas ──────────────────────────────────────────────────────────────────
//
// Structured outputs reject several JSON Schema keywords (minLength, maxLength,
// numeric bounds, recursion) and require additionalProperties:false plus an
// explicit `required` on every object. Length rules live in the gate instead.

/** Stage (a): people extracted from the site's own about/team pages. */
export const PEOPLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['people'],
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['full_name', 'title', 'confidence'],
        properties: {
          full_name: { type: 'string', description: 'Person name exactly as written on the page.' },
          title: { type: 'string', description: 'Their role, verbatim. Empty string if none is stated.' },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'high only when name and title appear together and clearly refer to this business.',
          },
        },
      },
    },
  },
} as const

/** Stage (c): a single proposed owner name, to be corroborated against the site. */
export const PROPOSED_OWNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['full_name', 'title', 'found'],
  properties: {
    found: { type: 'boolean', description: 'false when no individual owner is identifiable.' },
    full_name: { type: 'string', description: 'Empty string when found is false.' },
    title: { type: 'string', description: 'Empty string when found is false.' },
  },
} as const

export function peoplePrompt(businessName: string, pageText: string): string {
  return `You are extracting the owner or principal decision-maker of a small local business from its own website.

Business name: ${businessName}

Website text follows between the markers. It may contain navigation, marketing copy and unrelated names.

---BEGIN SITE TEXT---
${pageText}
---END SITE TEXT---

Return every named individual who appears to work at this business, with their stated role.

Rules:
- Only real people. Never return the business name, a department, a team ("Our Team", "Front Office"), or a job title with no person attached.
- Copy names and titles verbatim from the page. Do not invent, infer, or complete a partial name.
- If a person is listed with no title, return an empty string for title.
- Use confidence "high" only when the name and title appear together on the page and clearly belong to this business.
- Return an empty array if no individual people are named.`
}

export function proposedOwnerPrompt(
  businessName: string, editorialSummary: string, firstParagraph: string,
): string {
  return `Identify the owner of this small local business, if a specific individual is named.

Business name: ${businessName}
Google summary: ${editorialSummary || '(none)'}
First paragraph of their website: ${firstParagraph || '(none)'}

Return found=false unless a specific individual person is named as the owner, founder, principal, or lead practitioner. Do not guess from the business name — "Miller Family Dental" does not tell you anyone's first name. Do not return a business name, a family name alone, or a role with no person attached.`
}
