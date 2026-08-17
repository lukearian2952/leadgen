import { expandLocation } from '../src/lib/locations.js'
import { resolveNicheFilter } from '../src/lib/niche-types.js'
for (const q of ['Long Island, NY', 'New York']) {
  const c = expandLocation(q)
  console.log(`${q.padEnd(16)} -> ${c.length} cities: ${c.slice(0,10).join(', ')}${c.length>10?' …':''}`)
}
for (const n of ['med spa', 'dental practice', 'vehicle wrap shop']) {
  const f = resolveNicheFilter(n)
  console.log(`${n.padEnd(18)} active=${f.active} kw="${f.matchedKeyword}" allowed=[${[...f.allowed].join(',')}]`)
}
