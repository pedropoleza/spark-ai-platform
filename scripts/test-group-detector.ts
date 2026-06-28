/**
 * Guard rail do detector de contato-grupo (H46). PURO, sem GHL/DB.
 *   npx tsx scripts/test-group-detector.ts
 */
import {
  detectGroupContact,
  extractGroupJid,
  isGroupContact,
} from "../src/lib/account-assistant/group-contacts/detector";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log("\n=== extractGroupJid ===");
ok("JID legado (x-y@g.us)", extractGroupJid("12159770585-1623533526@g.us") === "12159770585-1623533526@g.us");
ok("JID novo (digits@g.us)", extractGroupJid("120363382820048510@g.us") === "120363382820048510@g.us");
ok("uppercase normaliza p/ lower", extractGroupJid("120363382820048510@G.US") === "120363382820048510@g.us");
ok("espaços trimados", extractGroupJid("  12345@g.us  ") === "12345@g.us");
ok("DM individual @s.whatsapp.net → null", extractGroupJid("5511999@s.whatsapp.net") === null);
ok("DM @c.us → null", extractGroupJid("5511999@c.us") === null);
ok("email pessoa → null", extractGroupJid("john.doe@gmail.com") === null);
ok("anti '@g.us.evil.com' (âncora $)", extractGroupJid("12345@g.us.evil.com") === null);
ok("vazio → null", extractGroupJid("") === null);
ok("null → null", extractGroupJid(null) === null);

console.log("\n=== isGroupContact (SÓ email @g.us — critério de segurança S1) ===");
ok("email @g.us → true", isGroupContact({ email: "120363382820048510@g.us" }) === true);
ok("email pessoa → false", isGroupContact({ email: "maria@gmail.com" }) === false);
ok("sem email → false", isGroupContact({ email: null }) === false);
ok("pessoa com sobrenome 'Grupo' mas email real → false (não pula opt-out)",
  isGroupContact({ email: "joao@gmail.com" }) === false);

console.log("\n=== detectGroupContact ===");
const realGroup = { firstName: "Brasileiros", lastName: "Philadelphia GRUPO", email: "12159770585-1623533526@g.us", tags: ["grupos disparo - matheus"] };
const s1 = detectGroupContact(realGroup);
ok("grupo real (caso Matheus): certain + jid + email_jid", s1.isGroup && s1.confidence === "certain" && s1.jid === "12159770585-1623533526@g.us" && s1.reason === "email_jid");

const nameOnly = { firstName: "negócios e vendas massachusets - usa", lastName: "grupo", email: null };
const s2 = detectGroupContact(nameOnly);
ok("nome termina 'grupo' sem email: likely, jid=null (não disparável)", s2.isGroup && s2.confidence === "likely" && s2.jid === null && s2.reason === "name_suffix");

const nameUpper = { name: "Aliança GRUPO", email: null };
ok("nome 'Aliança GRUPO' (acento+upper): likely", detectGroupContact(nameUpper).reason === "name_suffix");

const person = { firstName: "Maria", lastName: "Silva", email: "maria@gmail.com" };
const s3 = detectGroupContact(person);
ok("pessoa normal: isGroup=false, reason=none", s3.isGroup === false && s3.reason === "none" && s3.jid === null);

const personGrupoSurname = { firstName: "João", lastName: "Grupo", email: "joao@gmail.com" };
const s4 = detectGroupContact(personGrupoSurname);
ok("pessoa 'João Grupo' c/ email real: likely por nome MAS jid=null → não disparável", s4.isGroup && s4.jid === null && s4.confidence === "likely");
ok("…e isGroupContact (segurança) IGNORA o nome → false", isGroupContact(personGrupoSurname) === false);

const emailWins = { firstName: "Zé", lastName: "da Silva", email: "120363@g.us" };
ok("email @g.us tem precedência sobre nome-pessoa", detectGroupContact(emailWins).reason === "email_jid");

ok("'meugrupo' (sem boundary) NÃO casa nome-sufixo", detectGroupContact({ name: "meugrupo", email: null }).reason === "none");
ok("'grupo de vendas' (grupo no início) NÃO casa sufixo", detectGroupContact({ name: "grupo de vendas", email: null }).reason === "none");

console.log("\n=== tags (sinal fraco — NÃO marca isGroup sozinho) ===");
const tagOnly = { name: "Lista X", email: null, tags: ["grupos disparo - matheus"] };
const s5 = detectGroupContact(tagOnly, { groupTagHints: ["grupos disparo"] });
ok("tag bate hint: weak, isGroup=FALSE (exige co-sinal)", s5.isGroup === false && s5.confidence === "weak" && s5.reason === "tag");
ok("tag deburr (acento): 'gruposção' hint casa", detectGroupContact({ name: "x", email: null, tags: ["GRUPOSÇÃO disparo"] }, { groupTagHints: ["gruposcao"] }).reason === "tag");

ok("null contact → não quebra", detectGroupContact(null).isGroup === false);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
