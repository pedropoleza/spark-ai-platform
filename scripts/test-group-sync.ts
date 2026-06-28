/**
 * Guard rail dos helpers PUROS do sync de grupos (H46). Sem GHL/DB.
 *   npx tsx scripts/test-group-sync.ts
 */
import {
  isGroupCacheStale,
  groupUpsertFromContact,
  matchGroupByName,
} from "../src/lib/account-assistant/group-contacts/sync";
import type { ContactResult } from "../src/lib/account-assistant/filter-engine/types";
import type { GroupContactRow } from "../src/lib/repositories/group-contacts.repo";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const NOW = Date.parse("2026-06-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3600_000;

console.log("\n=== isGroupCacheStale ===");
ok("vazio (count 0) → stale", isGroupCacheStale(ago(HOUR), 0, NOW) === true);
ok("sem timestamp → stale", isGroupCacheStale(null, 5, NOW) === true);
ok("fresco (1h atrás, TTL 6h) → não stale", isGroupCacheStale(ago(HOUR), 5, NOW) === false);
ok("velho (7h atrás, TTL 6h) → stale", isGroupCacheStale(ago(7 * HOUR), 5, NOW) === true);
ok("timestamp lixo → stale", isGroupCacheStale("não-é-data", 5, NOW) === true);

console.log("\n=== groupUpsertFromContact (só email_jid vira linha) ===");
const grp: ContactResult = { id: "gqN8HUwxzaTLmGUtsORh", name: "Brasileiros Philadelphia GRUPO", firstName: "Brasileiros", lastName: "Philadelphia GRUPO", email: "12159770585-1623533526@g.us", phone: "+12015553526", tags: ["grupos disparo - matheus"] };
const u = groupUpsertFromContact(grp, "LOC1");
ok("grupo com JID → linha com contact_id real (não o JID)", u !== null && u.contact_id === "gqN8HUwxzaTLmGUtsORh" && u.jid === "12159770585-1623533526@g.us");
ok("group_name preenchido", u?.group_name === "Brasileiros Philadelphia GRUPO");
ok("tags preservadas", JSON.stringify(u?.tags) === JSON.stringify(["grupos disparo - matheus"]));

const nameOnly: ContactResult = { id: "X1", name: "Vendas GRUPO", firstName: "Vendas", lastName: "GRUPO", email: null, phone: null, tags: [] };
ok("nome-sufixo SEM email (não disparável) → null (não entra no cache)", groupUpsertFromContact(nameOnly, "LOC1") === null);

const person: ContactResult = { id: "P1", name: "Maria Silva", email: "maria@gmail.com", phone: "+5511999", tags: [] };
ok("pessoa normal → null", groupUpsertFromContact(person, "LOC1") === null);

console.log("\n=== matchGroupByName ===");
const mk = (id: string, name: string, jid: string): GroupContactRow => ({ id, location_id: "L", contact_id: id, jid, group_name: name, tags: null, member_count: null, is_archived: false, last_synced_at: ago(0) });
const groups: GroupContactRow[] = [
  mk("c1", "Brasileiros Philadelphia GRUPO", "111@g.us"),
  mk("c2", "Aliança grupo", "222@g.us"),
  mk("c3", "Vendas Massachusetts grupo", "333@g.us"),
  mk("c4", "Vendas Florida grupo", "444@g.us"),
];
ok("exato (deburr/acento): 'aliança grupo' → c2", matchGroupByName(groups, "Alianca GRUPO")?.contact_id === "c2");
ok("startsWith único: 'Brasileiros' → c1", matchGroupByName(groups, "Brasileiros")?.contact_id === "c1");
ok("includes único: 'Massachusetts' → c3", matchGroupByName(groups, "Massachusetts")?.contact_id === "c3");
ok("ambíguo: 'Vendas' (c3+c4) → null", matchGroupByName(groups, "Vendas") === null);
ok("por JID literal: '444@g.us' → c4", matchGroupByName(groups, "444@g.us")?.contact_id === "c4");
ok("inexistente → null", matchGroupByName(groups, "Não Existe XYZ") === null);
ok("vazio → null", matchGroupByName(groups, "  ") === null);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
