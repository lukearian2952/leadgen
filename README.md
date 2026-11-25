# LeadGen

A self-hosted lead generation platform that discovers, enriches, and verifies business leads from Google Maps. Built with a React frontend, Supabase backend, and a worker fleet for scalable data processing.

## Overview

LeadGen scrapes Google Maps for businesses in a target niche and location, then runs a multi-stage enrichment pipeline to find the business owner's name and a verified email address. Only leads that pass a strict quality gate (verified deliverable email, real owner name, valid MX records) make it into the final export.

## Architecture

| Component | Stack | Purpose |
|---|---|---|
| **Frontend** | React + Vite + Tailwind | Campaign management dashboard |
| **Backend** | Supabase (Postgres + Edge Functions + Auth) | API, database, auth, realtime |
| **Worker Fleet** | Node.js + graphile-worker | Discovery, enrichment, verification |
| **Verify Service** | Go (AfterShip/email-verifier) | SMTP email verification with IP rotation |
| **SearXNG** | Self-hosted | Meta-search for owner discovery |
| **Proxy** | Decodo residential proxies | IP rotation for scraping |

## Pipeline

1. **Discovery** — Google Maps scraper finds businesses matching the niche and location
2. **Enrichment** — Crawls business websites, runs AI extraction (Claude Haiku), and searches data providers to find owner names
3. **Verification** — Self-hosted SMTP verification with Verifalia as a safety net for uncertain results
4. **Gate** — Strict quality filter: real owner name + deliverable email + valid MX + correct location + matching business type
5. **Export** — Two CSVs: gate-passing leads and rejected leads with reasons

## Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Supabase project (hosted or self-hosted)
- Go 1.21+ (for verify-svc)

## Quick Start

```bash
# Clone and install
git clone https://github.com/lukearian2952/leadgen.git
cd leadgen
npm install

# Configure
cp .env.example .env
# Fill in your credentials (see .env.example for detailed docs)

# Start infrastructure
docker compose up -d

# Start the frontend
npm run dev

# Workers are started via docker compose
```

## Configuration

See `.env.example` for a fully documented list of all environment variables. Key services that need credentials:

- **Supabase** — Database and API (required)
- **Anthropic** — AI-powered owner extraction (optional, falls back to regex)
- **Decodo** — Residential proxy rotation (required for scraping)
- **Verifalia** — Email verification safety net (optional)

## Documentation

Detailed documentation lives in `docs/`:

| Document | Description |
|---|---|
| `HANDOFF.md` | Current state and context |
| `OPERATIONS.md` | How to run and operate the platform |
| `RUNBOOK.md` | Troubleshooting guide |
| `ARCHITECTURE.md` | System design |
| `DECISIONS.md` | Design rationale |

## Development

```bash
npm run dev        # Start Vite dev server (localhost:5173)
npm run build      # TypeScript compile + Vite production build
npm run preview    # Preview production build
npm run test:e2e   # Run Playwright end-to-end tests
```

Edge Functions are deployed via Supabase CLI:
```bash
supabase functions deploy <function-name>
```

## License

MIT
