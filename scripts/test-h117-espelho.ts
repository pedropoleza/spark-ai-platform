/**
 * H117: a cópia do provedor custom no WhatsApp não é "a equipe assumiu" (casos Ma e Antonio, Alves Cury).
 * Rodar: npx tsx scripts/test-h117-espelho.ts
 */
import { decidirPausaPeloHistorico, ehEspelhoDeEnvio, type MensagemDoHistoricoGhl } from "@/lib/queue/human-takeover";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
};
const T0 = Date.parse("2026-11-03T20:43:00Z");
const em = (s: number) => new Date(T0 + s * 1000).toISOString();
const confirmacaoIa = "Fechado, Ma! Terça-feira, 10/11, às 7 da noite, horário do leste. A confirmação chega por aqui 😊";
const confirmacaoCrm = "Olá Ma! Gostaria de confirmar nosso encontro agendado para: 11/10/2026 07:00 PM. O horário está ajustado para o fuso: EST.";
const base: MensagemDoHistoricoGhl[] = [
  { id: "m1", direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", userId: "taciana", body: confirmacaoIa, dateAdded: em(0) },
  { id: "m2", direction: "outbound", messageType: "TYPE_CUSTOM_SMS", source: "workflow", userId: "taciana", body: confirmacaoCrm, dateAdded: em(8) },
  { id: "m3", direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: confirmacaoCrm, dateAdded: em(10) },
  { id: "m4", direction: "inbound", messageType: "TYPE_WHATSAPP", body: "Está bem", dateAdded: em(60) },
];
const envios = [{ action_payload: { message: [confirmacaoIa], message_ids: ["m1"] }, created_at: em(1) }];

console.log("\n1) Espelho da confirmação do CRM");
ok("a cópia no WhatsApp é espelho", ehEspelhoDeEnvio(base[2], base));
ok("a mensagem da IA não é espelho de nada", !ehEspelhoDeEnvio(base[0], base));
{
  const d = decidirPausaPeloHistorico({ mensagens: base, enviosDaIa: envios, autoPause: true, estrito: false, retomadaManualEmMs: 0, agoraMs: T0 + 70_000 });
  ok("Ma: a IA NÃO pausa depois de agendar", d.motivo === null, d);
}

console.log("\n2) A equipe de verdade continua pausando");
{
  const comEquipe = [...base.slice(0, 3), { id: "m5", direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", userId: "marcos", body: "Ma, aqui é o Marcos, te liguei agora", dateAdded: em(40) }, base[3]];
  const d = decidirPausaPeloHistorico({ mensagens: comEquipe, enviosDaIa: envios, autoPause: true, estrito: false, retomadaManualEmMs: 0, agoraMs: T0 + 70_000 });
  ok("texto novo de alguém da equipe: pausa", d.motivo === "auto_pause:human_message:history", d);
}

console.log("\n3) Texto igual fora da janela não é espelho");
{
  const tarde: MensagemDoHistoricoGhl = { id: "m6", direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: confirmacaoCrm, dateAdded: em(600) };
  ok("10 min depois: não é espelho", !ehEspelhoDeEnvio(tarde, [...base, tarde]));
  const curto: MensagemDoHistoricoGhl = { id: "m7", direction: "outbound", messageType: "TYPE_WHATSAPP", source: "app", body: "ok", dateAdded: em(9) };
  ok("texto curto ('ok') nunca é espelho", !ehEspelhoDeEnvio(curto, [...base, { ...curto, id: "m8", source: "workflow" }]));
}

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
