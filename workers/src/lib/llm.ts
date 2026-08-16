// Anthropic calls for owner extraction.
//
// Ported from v1's `_shared/llm.ts`, which was already correct: every call uses
// structured outputs (`output_config.format`), so the model returns JSON that
// conforms to the schema. The pattern it replaced — "respond with ONLY a JSON
// array" plus JSON.parse in a try/catch — silently yielded nothing whenever the
// model added a sentence of preamble.
//
// New here: a response cache keyed by prompt hash, to hold the
// "<= 1 Haiku call per lead per stage" budget when a job is retried.

import { httpFetch } from '../net.js'
import { metrics } from '../metrics.js'

const API_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Haiku 4.5 is the right tier: this is extraction from a page of text, not
 * reasoning. It does NOT accept `output_config.effort` — sending one is an
 * error — so this module never sets it.
 */
export const MODEL = 'claude-haiku-4-5-20251001'

/** Per-token list prices, for the cost split. */
export const HAIKU_INPUT_PER_TOKEN = 1.00 / 1_000_000
export const HAIKU_OUTPUT_PER_TOKEN = 5.00 / 1_000_000

export interface LlmUsage { inputTokens: number; outputTokens: number; calls: number }
export interface LlmResult<T> { data: T | null; usage: LlmUsage; error: string | null }

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }
export const zeroUsage = (): LlmUsage => ({ ...ZERO })
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
  }
}
export function usageCostCents(u: LlmUsage): number {
  return (u.inputTokens * HAIKU_INPUT_PER_TOKEN + u.outputTokens * HAIKU_OUTPUT_PER_TOKEN) * 100
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
  stop_reason?: string
}

const cache = new Map<string, unknown>()

function hashPrompt(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

export async function askJson<T>(
  apiKey: string, prompt: string, schema: Record<string, unknown>, maxTokens = 1024,
): Promise<LlmResult<T>> {
  const key = hashPrompt(prompt + JSON.stringify(schema))
  if (cache.has(key)) return { data: cache.get(key) as T, usage: zeroUsage(), error: null }

  try {
    const res = await httpFetch(API_URL, {
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
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { data: null, usage: { ...ZERO, calls: 1 }, error: `HTTP ${res.status} ${body.slice(0, 200)}` }
    }

    const json = await res.json() as AnthropicResponse
    const usage: LlmUsage = {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      calls: 1,
    }
    metrics.llmTokens.inc({ direction: 'input' }, usage.inputTokens)
    metrics.llmTokens.inc({ direction: 'output' }, usage.outputTokens)

    // A truncated response is not valid JSON whatever the schema says.
    if (json.stop_reason === 'max_tokens') {
      return { data: null, usage, error: 'response truncated at max_tokens' }
    }
    const text = json.content?.find(b => b.type === 'text')?.text ?? json.content?.[0]?.text ?? ''
    if (!text.trim()) return { data: null, usage, error: 'empty response' }

    const parsed = JSON.parse(text) as T
    cache.set(key, parsed)
    return { data: parsed, usage, error: null }
  } catch (err) {
    return { data: null, usage: { ...ZERO, calls: 1 }, error: (err as Error).message }
  }
}

// ── schema ───────────────────────────────────────────────────────────────────
//
// Structured outputs reject minLength/maxLength/numeric bounds and require
// additionalProperties:false plus an explicit `required` on every object.
// Length rules live in identity.ts instead.

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
            type: 'string', enum: ['high', 'medium', 'low'],
            description: 'high only when name and title appear together and clearly refer to this business.',
          },
        },
      },
    },
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
