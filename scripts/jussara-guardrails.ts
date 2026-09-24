/**
 * Guardrails da religação da IA de vendas da Jussara (pedido do council 23/09).
 *
 * NÃO liga o agente. Só prepara a config. A religação segue sendo
 * `scripts/religa-jussara.ts --apply`, com OK do Pedro.
 *
 *   npx tsx scripts/jussara-guardrails.ts            # mostra o diff
 *   npx tsx scripts/jussara-guardrails.ts --apply    # grava
 *   npx tsx scripts/jussara-guardrails.ts --revert   # volta ao estado de 24/09
 *
 * O que muda e POR QUE cada um é determinístico (a lição H73 desta base é que
 * config que só vive no prompt não sobrevive ao turno seguinte):
 *
 *  1. has_disease / takes_medication → required:true
 *     Isso é PROMPT (renderiza "OBRIGATORIO" na seção de dados). Faz o agente
 *     PERGUNTAR. Não é o que impede de agendar — quem impede é o item 2.
 *  2. automations: has_disease|takes_medication == "sim" → avisa o lead,
 *     etiqueta e PAUSA a IA. Roda no `reaction-engine` (determinístico, fora do
 *     LLM). Regex `^\s*sim\b` em vez de equals porque o campo às vezes vem
 *     "sim, tenho diabetes" — medido na frota. O operador é case-insensitive.
 *  3. working_hours 08:00-21:00 ET, todos os dias.
 *     Fora da janela o inbound NÃO é descartado: entra na fila com
 *     process_after = próxima abertura. Lead de 02:00 é respondido às 08:00.
 *  4. entry_by_automation = true (H90).
 *     A IA cala na PRIMEIRA mensagem (o clique do anúncio, que o workflow já
 *     responde com apresentação + menu) e assume da SEGUNDA em diante — que é
 *     o "2" do lead. Sem isso, os dois falam juntos no primeiro turno.
 *  5. notifications.alerta_whatsapp → avisa a Jussara quando a IA se pausa.
 *     Sem isso o item 2 vira lead parado sem ninguém saber (H95).
 *
 * NÃO mexe em: targeting_rules (o gate-ponte de 8 folhas está certo),
 * custom_instructions (a regra do "não sou robô" fica intacta), status.
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const AGENT = "a297dadc-873a-4803-885d-472c65414168";
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const TEL_JUSSARA = "+16892033343";

const DIAS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

const TEXTO_HANDOFF_SAUDE =
  "Obrigada por me contar 🙏 Nesse caso eu prefiro te explicar pessoalmente, " +
  "porque cada situação muda as opções que dá pra montar. Eu te chamo aqui " +
  "mesmo pra gente conversar com calma, tá?";

export const ALVO = {
  working_hours: {
    enabled: true,
    mode: "only_during" as const,
    timezone: "America/New_York",
    schedule: Object.fromEntries(DIAS.map((d) => [d, { enabled: true, start: "08:00", end: "21:00" }])),
  },
  entry_by_automation: true,
  automations: [
    {
      id: "saude-doenca",
      trigger: { kind: "on_data_field_set" as const, field_key: "has_disease", operator: "matches_regex" as const, value: "^\\s*sim\\b" },
      actions: [
        { type: "send_text_fixed" as const, text: TEXTO_HANDOFF_SAUDE },
        { type: "add_tag" as const, tag: "saude-handoff" },
        { type: "pause_ai" as const, pause_minutes: 0 },
      ],
    },
    {
      id: "saude-remedio",
      trigger: { kind: "on_data_field_set" as const, field_key: "takes_medication", operator: "matches_regex" as const, value: "^\\s*sim\\b" },
      actions: [
        { type: "send_text_fixed" as const, text: TEXTO_HANDOFF_SAUDE },
        { type: "add_tag" as const, tag: "saude-handoff" },
        { type: "pause_ai" as const, pause_minutes: 0 },
      ],
    },
  ],
};

const ANTES = {
  working_hours: { enabled: false, mode: "only_during", schedule: {}, timezone: "America/New_York" },
  entry_by_automation: false,
  automations: [] as unknown[],
};

async function main() {
  const sb = createAdminClient();
  const { data: c, error } = await sb.from("agent_configs").select("*").eq("agent_id", AGENT).single();
  if (error) throw new Error(error.message);
  const cc = c as Record<string, unknown>;

  const df = (cc.data_fields as Array<Record<string, unknown>>) || [];
  const dfNovo = df.map((f) =>
    f.key === "has_disease" || f.key === "takes_medication" ? { ...f, required: !REVERT } : f
  );

  const notif = { ...((cc.notifications as Record<string, unknown>) || {}) };
  notif.alerta_whatsapp = REVERT
    ? undefined
    : { enabled: true, phone: TEL_JUSSARA, motivos: ["ia_pausada", "turno_falhou", "envio_falhou"] };

  const patch = REVERT
    ? { ...ANTES, data_fields: dfNovo, notifications: notif }
    : { ...ALVO, data_fields: dfNovo, notifications: notif };

  console.log(`\nAGENTE ${AGENT}  (modo: ${REVERT ? "REVERT" : APPLY ? "APPLY" : "dry-run"})\n`);
  for (const [k, v] of Object.entries(patch)) {
    const de = JSON.stringify(cc[k]);
    const para = JSON.stringify(v);
    if (de === para) { console.log(`  = ${k}: (sem mudança)`); continue; }
    console.log(`  ~ ${k}`);
    console.log(`      de:   ${de && de.length > 220 ? de.slice(0, 220) + "…" : de}`);
    console.log(`      para: ${para && para.length > 220 ? para.slice(0, 220) + "…" : para}`);
  }

  const { data: ag } = await sb.from("agents").select("status").eq("id", AGENT).single();
  console.log(`\n  status do agente: ${(ag as { status: string })?.status}  (este script NÃO liga)`);

  if (!APPLY && !REVERT) { console.log("\n[dry-run] nada gravado. Use --apply.\n"); return; }

  const { error: e2 } = await sb.from("agent_configs").update(patch).eq("agent_id", AGENT);
  if (e2) throw new Error(e2.message);
  console.log(`\n✅ config gravada. O agente segue ${(ag as { status: string })?.status}.`);
  console.log("   Religar (com OK do Pedro): npx tsx scripts/religa-jussara.ts --apply\n");
}

// Só roda quando chamado direto. Sem esta guarda, `import { ALVO }` daqui
// executaria o patch — e num processo com `--apply` no argv, gravaria de verdade.
if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
}
