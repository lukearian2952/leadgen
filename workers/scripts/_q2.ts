import pg from 'pg'
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}, max:1,
  connectionTimeoutMillis: 10000, query_timeout: 30000 })
const r = await db.query(process.argv[2])
console.log(JSON.stringify(r.rows, null, 1))
await db.end()
