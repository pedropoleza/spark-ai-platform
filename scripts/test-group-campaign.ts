/**
 * Testes da feature de Campanhas em Grupo (Pedro 2026-06-18).
 *
 * Cobre as unidades DETERMINÍSTICAS de maior risco (sem DB/rede):
 *  1. normalizeStevoNumber — PRESERVA JID de grupo (@g.us), normaliza individual.
 *  2. scoreSpamRisk — categorias, níveis, bloqueio extremo.
 *  3. clampGroupInterval / dailyTimeToCron — pacing + recorrência.
 *  4. parseGroup — parse defensivo da forma real do /group/list.
 *  5. parseTermsResponse reusado pra Parte 2 (accept/reject/anti-trap unclear).
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/test-group-campaign.ts
 */
import { normalizeStevoNumber } from "../src/lib/account-assistant/webhook/stevo-send";
import { parseGroup } from "../src/lib/account-assistant/webhook/stevo-groups";
import { scoreSpamRisk } from "../src/lib/account-assistant/group-campaigns/spam-advisor";
import {
  clampGroupInterval,
  dailyTimeToCron,
  GROUP_INTERVAL_FLOOR_SECONDS,
  GROUP_INTERVAL_SECONDS_DEFAULT,
} from "../src/lib/account-assistant/group-campaigns/config";
import { parseTermsResponse } from "../src/lib/account-assistant/terms";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("\n=== 1. normalizeStevoNumber: JID de grupo PRESERVADO ===");
const groupJid = "120363401234567890-1610000000@g.us";
ok("JID de grupo com hífen preservado intacto", normalizeStevoNumber(groupJid) === groupJid, normalizeStevoNumber(groupJid));
ok("JID de grupo só-id preservado", normalizeStevoNumber("120363999@g.us") === "120363999@g.us");
ok("JID de grupo case-insensitive (@G.US)", normalizeStevoNumber("120363@G.US") === "120363@G.US");
ok("contato individual @s.whatsapp.net → só dígitos", normalizeStevoNumber("17867717077@s.whatsapp.net") === "17867717077");
ok("contato com + → só dígitos", normalizeStevoNumber("+1 786 771 7077") === "17867717077");
ok("JID com espaço ao redor preservado (trim)", normalizeStevoNumber("  120363-161@g.us  ") === "120363-161@g.us");

console.log("\n=== 2. scoreSpamRisk ===");
const benign = scoreSpamRisk("Bom dia pessoal! Reunião hoje às 19h pra falar de proteção de renda. Quem topa?");
ok("texto benigno → low / sem bloqueio", benign.level === "low" && !benign.block, benign.level);

const financial = scoreSpamRisk("Esse plano rende 11% ao ano e você retira a qualquer momento, sem risco!");
ok("promessa financeira detectada", financial.hits.some((h) => h.category === "promessa_retorno_garantido"));
ok("promessa financeira → nível >= medium", financial.level !== "low", financial.level);

const easy = scoreSpamRisk("GANHE renda extra garantida trabalhando de casa!");
ok("renda fácil detectada", easy.hits.some((h) => h.category === "renda_facil_esquema"));

const urgency = scoreSpamRisk("Últimas vagas! Só hoje, corre!");
ok("urgência detectada", urgency.hits.some((h) => h.category === "urgencia_escassez"));

const extreme = scoreSpamRisk("Rende 12% ao mês garantido, últimas vagas só hoje! Clique aqui: https://x.co/y");
ok("combo extremo → block=true", extreme.block === true, `level=${extreme.level}`);
ok("combo extremo → level extreme", extreme.level === "extreme");

const caps = scoreSpamRisk("OFERTA IMPERDÍVEL ABSURDA AGORA MESMO COMPRE JÁ HOJE");
ok("CAPS detectado (peso baixo, sem bloqueio)", caps.hits.some((h) => h.category === "caps_pontuacao") && !caps.block);

console.log("\n=== 3. clampGroupInterval / dailyTimeToCron ===");
ok("interval abaixo do piso → piso", clampGroupInterval(60) === GROUP_INTERVAL_FLOOR_SECONDS, String(clampGroupInterval(60)));
ok("interval válido → arredondado", clampGroupInterval(420.6) === 421);
ok("interval inválido → default", clampGroupInterval("abc") === GROUP_INTERVAL_SECONDS_DEFAULT);
ok("interval 0/negativo → default", clampGroupInterval(0) === GROUP_INTERVAL_SECONDS_DEFAULT && clampGroupInterval(-5) === GROUP_INTERVAL_SECONDS_DEFAULT);
ok("dailyTime 07:30 → '30 7 * * *'", dailyTimeToCron("07:30") === "30 7 * * *", String(dailyTimeToCron("07:30")));
ok("dailyTime 23:05 → '5 23 * * *'", dailyTimeToCron("23:05") === "5 23 * * *");
ok("dailyTime inválido (25:00) → null", dailyTimeToCron("25:00") === null);
ok("dailyTime inválido (7:5) → null", dailyTimeToCron("7:5") === null);
ok("dailyTime lixo → null", dailyTimeToCron("manhã") === null);

console.log("\n=== 4. parseGroup (forma real do /group/list) ===");
const realGroup = parseGroup({
  JID: "120363401234567890-1610000000@g.us",
  Name: "Comunidade Spark ⚡️",
  OwnerJID: "5511999999999@s.whatsapp.net",
  ParticipantCount: 108,
  IsAnnounce: false,
  IsLocked: true,
  Participants: [
    { JID: "5511999999999@s.whatsapp.net", IsSuperAdmin: true },
    { JID: "17867717077@s.whatsapp.net", IsAdmin: true },
    { JID: "5511888888888@s.whatsapp.net" },
  ],
});
ok("grupo parseado", realGroup !== null);
ok("nome correto", realGroup?.name === "Comunidade Spark ⚡️");
ok("jid correto", realGroup?.jid === "120363401234567890-1610000000@g.us");
ok("participantCount do campo", realGroup?.participantCount === 108);
ok("isAnnounce false", realGroup?.isAnnounce === false);
ok("superadmin detectado como admin", realGroup?.participants[0].isAdmin === true && realGroup?.participants[0].isSuperAdmin === true);
ok("admin detectado", realGroup?.participants[1].isAdmin === true);
ok("membro comum não-admin", realGroup?.participants[2].isAdmin === false);
ok("phone derivado do JID", realGroup?.participants[1].phone === "+17867717077");

const announceGroup = parseGroup({ JID: "120363777@g.us", Name: "Avisos", IsAnnounce: true, Participants: [] });
ok("isAnnounce true parseado", announceGroup?.isAnnounce === true);
ok("count cai pro tamanho do array quando sem ParticipantCount", announceGroup?.participantCount === 0);

ok("não-grupo (s.whatsapp.net) → null", parseGroup({ JID: "5511999@s.whatsapp.net", Name: "x" }) === null);
ok("sem JID → null", parseGroup({ Name: "sem jid" }) === null);
ok("lixo → null", parseGroup("nope") === null);

console.log("\n=== 5. parseTermsResponse reusado pra Parte 2 ===");
ok("'aceito' → accept", parseTermsResponse("aceito") === "accept");
ok("'sim, pode' → accept", parseTermsResponse("sim, pode") === "accept");
ok("'não' → reject", parseTermsResponse("não") === "reject");
ok("'agora não' → reject", parseTermsResponse("agora não") === "reject");
ok("mudou de assunto → unclear (anti-trap)", parseTermsResponse("qual minha agenda hoje?") === "unclear");
ok("'não tá ok pra mim' NÃO vira accept (LGPD)", parseTermsResponse("não tá ok pra mim") === "reject");

console.log(`\n=== RESULTADO: ${pass} passou, ${fail} falhou ===`);
process.exit(fail === 0 ? 0 : 1);
