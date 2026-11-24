/**
 * H126: envio por automação (texto fixo e mídia) vira send_message com message_ids
 * (anti-eco) e o link da mídia vale 7 dias.
 * Rodar: npx tsx scripts/test-h126-midia-automacao.ts
 */
import { registrarEnvioDaAutomacao, MEDIA_URL_TTL_SECONDS } from "@/lib/ai/reaction-engine";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };

const gravados: Array<Record<string, any>> = [];
const fake = { from: (t: string) => ({ insert: async (row: Record<string, any>) => { gravados.push({ t, ...row }); return { error: null }; } }) } as any;
const ctx = { agentId: "A", locationId: "L", companyId: "C", contactId: "K", conversationId: "" } as any;

(async () => {
  ok("link da mídia vale 7 dias", MEDIA_URL_TTL_SECONDS === 604800);
  await registrarEnvioDaAutomacao(fake, ctx, ["Oie! Lembramos de você..."], { messageId: "MSG1", conversationId: "CONV1" }, "send_media");
  const g = gravados[0];
  ok("grava no execution_log", g?.t === "execution_log");
  ok("como send_message (o anti-eco procura este tipo)", g?.action_type === "send_message" && g?.success === true);
  ok("com o messageId do envio", JSON.stringify(g?.action_payload?.message_ids) === '["MSG1"]', g);
  ok("com o texto enviado (a legenda)", g?.action_payload?.message?.[0]?.startsWith("Oie!"));
  ok("marca a origem automação", g?.action_payload?.source === "automation" && g?.action_payload?.automation_action === "send_media");
  ok("conversation_id cai no da resposta quando o contexto não tem", g?.conversation_id === "CONV1");
  await registrarEnvioDaAutomacao(fake, ctx, ["texto"], {}, "send_text_fixed");
  ok("sem messageId, não inventa message_ids", gravados[1]?.action_payload?.message_ids === undefined);
  console.log(`\n${pass} ok · ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
})();
