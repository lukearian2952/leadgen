# Weekly reports

Written every Monday 08:00 UTC by `infra/weekly-report.sh`, which runs
`workers/scripts/weekly-report.ts`. One file per week, `YYYY-MM-DD.md`.

**They are generated on the server and do not reach git on their own.** Bring
them back with:

```bash
rsync -az root@92.112.184.200:/opt/leadgen/docs/REPORTS/weekly/ docs/REPORTS/weekly/
```

The point of committing them is the diff. A single report saying "280 Verifalia
credits" says less than two a week apart showing 883 → 280. Read the
**Needs a human** section first; everything below it is context for that.

Anything unclear reading one cold is a bug in the report, not in your memory of
it — fix `weekly-report.ts`.
