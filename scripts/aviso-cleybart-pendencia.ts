/**
 * 2º aviso pro Cleybart (Vergus), 08/10: o que foi resolvido e o que ficou
 * pendente na Bia. Texto aprovado pelo Pedro, envio imediato via SparkBot.
 *
 * Por que existe: o 1º aviso (08/10 9h ET) dizia que a ativação estava
 * arrumada, mas a Bia nunca mandou uma mensagem desde que foi criada (03/09).
 * A regra dela é a tag "ia-ativa" e nenhum lead recebe essa tag. Os leads de
 * anúncio caem todos no Novo Lead do funil Produto (Antonio, Emerson, Maria),
 * e a tag "anuncio" NÃO está em todos (o Emerson, de formulário, veio sem).
 *
 *   npx tsx scripts/aviso-cleybart-pendencia.ts            # mostra
 *   npx tsx scripts/aviso-cleybart-pendencia.ts --apply    # envia agora
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const MARCA = "aviso_cleybart_pendencia_2026_10_08";
const PHONE = "+18435756775";
const TEXTO =
`Oi Cleybart, tudo bem? Complementando a mensagem de hoje cedo sobre a Bia.

O que era problema do nosso lado já está resolvido: a regra por funil agora funciona, inclusive pro lead que já entra direto no Novo Lead, como os de formulário.

Ficou pendente uma decisão sua. Por enquanto a Bia só atende contatos com a tag "ia-ativa", e os leads que estão chegando não recebem essa tag. Por isso ela ainda não conversou com ninguém. Hoje à tarde, por exemplo, entrou a Maria Cleunice pelo anúncio do Facebook e a Bia não respondeu, porque ela não tinha essa tag.

Nossa sugestão é ligar a Bia pros leads que entram no Novo Lead do funil Produto, que é onde estão caindo os leads de anúncio. Só precisa combinar uma coisa com o time: quando alguém da equipe responde o lead, a Bia para de falar com ele pra não atropelar. Então o ideal é deixar o primeiro atendimento desses leads com ela.

Outra coisa: ela está configurada pra atender de segunda a sexta, das 9h às 17h, e vários leads chegam à noite ou de manhã cedo. Se quiser que ela atenda também nesses horários e no fim de semana, é só falar.

Me fala se podemos seguir assim, que a gente configura e testa junto com você.`;

(async () => {
  const sb = createAdminClient();
  const { data: rep } = await sb.from("rep_identities").select("id,display_name,active_location_id,proactive_paused_at,terms_accepted_at,terms_rejected_at").eq("phone", PHONE).single();
  const r = rep as { id: string; display_name: string; active_location_id: string; proactive_paused_at: string | null; terms_accepted_at: string | null; terms_rejected_at: string | null };
  const travessoes = (TEXTO.match(/—|–/g) || []).length;
  console.log(`${r.display_name} (${PHONE}) · location ${r.active_location_id}`);
  console.log(`termos: ${r.terms_accepted_at && !r.terms_rejected_at ? "ok" : "NÃO"} | proativo pausado: ${r.proactive_paused_at ? "SIM" : "não"} | travessões: ${travessoes}`);
  console.log(`${"-".repeat(64)}\n🔔 Atualização da Spark\n\n${TEXTO}\n${"-".repeat(64)}`);
  if (travessoes) throw new Error("texto com travessão");
  if (!r.terms_accepted_at || r.terms_rejected_at) throw new Error("rep sem aceite de termos");
  if (!APPLY) { console.log("[dry-run] use --apply pra enviar agora"); return; }
  // Qualquer status: nunca reenvia (lição do aviso do Willian, 07/10).
  const { data: ja } = await sb.from("assistant_scheduled_tasks").select("id,status").eq("rep_id", r.id).contains("task_payload", { marca: MARCA });
  if ((ja || []).length) { console.log(`já existe (${(ja || []).map((x) => x.status).join(", ")}), não duplico`); return; }
  const { data: ins, error } = await sb.from("assistant_scheduled_tasks").insert({
    rep_id: r.id, location_id: r.active_location_id, task_type: "reminder", status: "pending",
    next_run_at: new Date().toISOString(), cron_expr: null, delivery_channel: "whatsapp",
    task_payload: { title: "Atualização da Spark", message: TEXTO, source: "spark_team_support", marca: MARCA, test_session_id: null },
  }).select("id").single();
  if (error) throw new Error(error.message);
  console.log(`✅ na fila pra agora (task ${ins!.id}); o cron do SparkBot entrega em até ~30s`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
