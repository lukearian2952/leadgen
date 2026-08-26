// Ad-hoc read-only query helper: npx tsx scripts/q.ts "select 1"
import pg from 'pg'
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, max: 1,
})
const sql = process.argv[2]
if (!sql) throw new Error('usage: q.ts "<sql>"')
const res = await db.query(sql)
console.log(JSON.stringify(res.rows, null, 1))
await db.end()
