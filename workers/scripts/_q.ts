import { appPool } from './_db.js'
const db = appPool(1)
console.log(JSON.stringify((await db.query(process.argv[2])).rows, null, 1))
await db.end()
