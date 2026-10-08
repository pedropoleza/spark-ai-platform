/**
 * Agenda o aviso de "está arrumado" pro Willian (Alves Cury) e pro Cleybart
 * (Vergus), via SparkBot, amanhã 9h no fuso de cada um. Pedido do Pedro 07/10.
 * task_type "reminder" = kind "requested" no silence-gate: não leva aviso de
 * silêncio nem conta como proativo ignorado (o Cleybart já tinha 2).
 *
 *   npx tsx scripts/agendar-aviso-correcao.ts            # mostra textos e horários
 *   npx tsx scripts/agendar-aviso-correcao.ts --apply    # agenda
 *   npx tsx scripts/agendar-aviso-correcao.ts --cancel   # cancela os dois
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const CANCEL = process.argv.includes("--cancel");
const MARCA = "aviso_correcao_2026_10_07";

// ⚠️ O aviso do Willian foi CANCELADO em 07/10 pelo General OS: ele NÃO é da
// Alves Cury (é da conta VKJITQwWwWVRzce0dbSb, com a Sofia), e o aviso certo dele
// sai pelo OS. "Não reagendem." O `--apply` deste script só pula duplicata
// PENDENTE, então rodá-lo de novo recriaria o aviso cancelado. Por isso o item
// dele fica com `naoEnviar` e o loop pula.
const AVISOS: Array<{ phone: string; tz: string; texto: string; naoEnviar?: string }> = [
  {
    naoEnviar: "cancelado em 07/10 (Willian não é da Alves Cury); o aviso dele sai pelo OS",
    phone: "+12062096191",
    tz: "America/Chicago",
    texto:
`Oi Willian, tudo bem? Arrumamos os dois pontos que vocês reportaram na Alves Cury.

A IA tinha mandado mensagem pra pessoas da equipe porque estava sendo ligada por um campo de agendamento. Tiramos esse gatilho, e agora ela nunca fala com quem tem tag de agente ou de cliente.

O botão da IA agora aparece na tela do contato mesmo com a IA desligada na conta. E o "Desligar" passou a valer também pra quem ainda não conversou com ela, então dá pra marcar antes de religar quem ela não deve atender.

Os agentes continuam desligados. Quando quiserem religar é só avisar a gente.`,
  },
  {
    phone: "+18435756775",
    tz: "America/New_York",
    texto:
`Oi Cleybart, tudo bem? Olhamos a ativação da Bia que você testou.

A regra por funil tinha um erro do nosso lado e não funcionava. Já corrigimos, pode usar.

A regra por tag estava funcionando. O teste não respondeu porque o contato de teste tinha uma mensagem de alguém da equipe, e a IA se pausa quando vê um humano conversando, pra não atropelar. Pra testar, use um contato em que ninguém do time escreveu.

Se for ativar por funil, vale ajustar pra IA seguir na conversa mesmo quando o lead muda de etapa. Se quiser, a gente configura pra você.`,
  },
];

/** Instante UTC de "amanhã às HH:00" no fuso dado (DST-correto). */
function amanhaAs(hora: number, tz: string): Date {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = hoje.split("-").map(Number);
  const alvo = Date.UTC(y, m - 1, d + 1, hora, 0, 0);
  // offset do fuso naquele instante
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(alvo));
  const horaLocal = Number(parts.find((p) => p.type === "hour")!.value);
  return new Date(alvo + (hora - horaLocal) * 3600e3);
}

(async () => {
  const sb = createAdminClient();
  if (CANCEL) {
    const { data } = await sb.from("assistant_scheduled_tasks").update({ status: "cancelled" })
      .eq("status", "pending").contains("task_payload", { marca: MARCA }).select("id");
    console.log(`cancelados: ${(data || []).length}`);
    return;
  }
  for (const a of AVISOS) {
    if (a.naoEnviar) { console.log(`\n⏭️  ${a.phone}: não envia (${a.naoEnviar})`); continue; }
    const { data: rep } = await sb.from("rep_identities").select("id,display_name,active_location_id,proactive_paused_at,terms_accepted_at").eq("phone", a.phone).single();
    const r = rep as { id: string; display_name: string; active_location_id: string; proactive_paused_at: string | null; terms_accepted_at: string | null };
    const quando = amanhaAs(9, a.tz);
    const local = quando.toLocaleString("pt-BR", { timeZone: a.tz, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    console.log(`\n${"=".repeat(64)}\n${r.display_name} (${a.phone})\nsai: ${local} (${a.tz}) = ${quando.toISOString()}`);
    console.log(`termos: ${r.terms_accepted_at ? "ok" : "NÃO"} | pausado: ${r.proactive_paused_at ? "SIM" : "não"}`);
    console.log(`travessões no texto: ${(a.texto.match(/—|–/g) || []).length}\n${"-".repeat(64)}\n🔔 Atualização da Spark\n\n${a.texto}`);
    if (!APPLY) continue;
    // Qualquer status: aviso já ENVIADO (completed) ou CANCELADO também não volta.
    const { data: ja } = await sb.from("assistant_scheduled_tasks").select("id,status").eq("rep_id", r.id).contains("task_payload", { marca: MARCA });
    if ((ja || []).length) { console.log(`→ já existe (${(ja || []).map((x) => x.status).join(", ")}), não duplico`); continue; }
    const { error } = await sb.from("assistant_scheduled_tasks").insert({
      rep_id: r.id, location_id: r.active_location_id, task_type: "reminder", status: "pending",
      next_run_at: quando.toISOString(), cron_expr: null, delivery_channel: "whatsapp",
      task_payload: { title: "Atualização da Spark", message: a.texto, source: "spark_team_support", marca: MARCA, test_session_id: null },
    });
    if (error) throw new Error(error.message);
    console.log("→ ✅ agendado");
  }
  if (!APPLY) console.log("\n[dry-run] nada agendado. Use --apply.");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
