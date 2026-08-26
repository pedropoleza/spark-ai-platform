/**
 * TESTE AO VIVO do gatilho por TAG na conta da Bianca.
 *
 * Pergunta a responder: quando alguém adiciona uma tag num contato, o webhook
 * `ContactTagUpdate` chega no nosso endpoint? (O handler F27.D existe e a flag
 * PROACTIVE_EVENTS_ENABLED está em prod há 96 dias — falta saber se o EVENTO
 * é entregue.)
 *
 * Como: cria um contato DESCARTÁVEL (sem telefone/IG real → não há conversa,
 * então nenhuma mensagem pode sair), adiciona a tag, espera e lê
 * `inbound_webhook_samples` (que grava TODO payload antes de qualquer skip).
 * No fim, APAGA o contato.
 *
 *   npx tsx scripts/_teste-gatilho-tag.ts [--tag=novo seguidor] [--manter]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";
const TAG = process.argv.find((a) => a.startsWith("--tag="))?.slice(6) || "novo seguidor";
const MANTER = process.argv.includes("--manter");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const c = new GHLClient(loc.company_id, LOC);

  const marcador = `ZZ-TESTE-GATILHO-${Date.now().toString(36)}`;
  console.log(`=== TESTE DO GATILHO POR TAG ===`);
  console.log(`tag: "${TAG}" · contato descartável: ${marcador}\n`);

  // 1) contato descartável — sem telefone e sem IG: nenhuma conversa existe,
  //    então mesmo que algo dispare, não há canal por onde sair.
  const criado = await c.post<{ contact?: { id: string } }>("/contacts/", {
    locationId: LOC,
    firstName: "ZZ Teste",
    lastName: marcador,
    email: `${marcador.toLowerCase()}@teste-spark.invalid`,
  });
  const contactId = criado.contact?.id;
  if (!contactId) { console.error("❌ não criou contato"); process.exit(1); }
  console.log(`contato criado: ${contactId}`);

  const desde = new Date(Date.now() - 5000).toISOString();
  await sleep(2000);

  // 2) adiciona a tag (é o evento sob teste)
  await c.post(`/contacts/${contactId}/tags`, { tags: [TAG] });
  console.log(`tag "${TAG}" adicionada · aguardando webhook...`);

  // 3) observa por até 45s
  let achou: Record<string, unknown> | null = null;
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const { data } = await sb
      .from("inbound_webhook_samples")
      .select("received_at, message_type, contact_id, raw")
      .eq("location_id", LOC)
      .gte("received_at", desde)
      .order("received_at", { ascending: false })
      .limit(20);
    const tipos = (data || []).map((r) => `${r.message_type}${r.contact_id === contactId ? "*" : ""}`);
    process.stdout.write(`\r  ${(i + 1) * 3}s — eventos recebidos: ${tipos.join(", ") || "(nenhum)"}          `);
    const hit = (data || []).find((r) => String(r.message_type || "").toLowerCase().includes("tag"));
    if (hit) { achou = hit as Record<string, unknown>; break; }
  }
  console.log("\n");

  if (achou) {
    console.log(`✅ WEBHOOK DE TAG CHEGOU: type="${achou.message_type}" em ${achou.received_at}`);
    console.log(`payload (trecho): ${JSON.stringify(achou.raw).slice(0, 500)}`);
  } else {
    console.log(`❌ NENHUM webhook de tag em 45s.`);
    const { data: tudo } = await sb
      .from("inbound_webhook_samples")
      .select("received_at, message_type, contact_id")
      .eq("location_id", LOC)
      .gte("received_at", desde)
      .order("received_at", { ascending: false });
    console.log(`   eventos que chegaram nessa janela: ${(tudo || []).map((r) => r.message_type).join(", ") || "(nenhum)"}`);
    console.log(`   → o app não está assinando ContactTagUpdate (ou a conta não o envia).`);
  }

  // 4) o gatilho chegou a enfileirar algo?
  const { data: fila } = await sb
    .from("message_queue").select("received_at, message_body, agent_id")
    .eq("contact_id", contactId);
  const { data: log } = await sb
    .from("execution_log").select("created_at, action_type").eq("contact_id", contactId);
  console.log(`\nfila pra esse contato: ${(fila || []).length} linha(s)`);
  (fila || []).forEach((f) => console.log(`   ${f.received_at} · ${String(f.message_body).slice(0, 80)}`));
  console.log(`execution_log: ${(log || []).length} linha(s) ${(log || []).map((l) => l.action_type).join(", ")}`);

  // 5) limpeza
  if (!MANTER) {
    await c.delete(`/contacts/${contactId}`).catch((e) => console.log(`(aviso) delete falhou: ${e.message}`));
    console.log(`\ncontato de teste apagado.`);
  } else {
    console.log(`\n(--manter) contato ${contactId} preservado — apagar à mão depois.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
