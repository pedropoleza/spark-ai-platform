/**
 * Acorda os leads que ficaram sem resposta durante um apagão de ENTREGA.
 *
 * O caso é diferente do `reenqueueInboundsSincePause`: aqui o turno RODOU, a IA
 * escreveu, e só a ENTREGA falhou (`execution_log.send_message success=false`).
 * A linha da fila ficou `completed`, e nada no motor reprocessa `completed` —
 * então a conversa fica parada pra sempre, esperando o lead escrever de novo.
 *
 * O que faz: devolve pra `pending` a ÚLTIMA mensagem de cada contato cuja
 * resposta não foi entregue na janela. O queue-processor agrupa por
 * (agente, contato), então vira UM turno novo, já com o histórico.
 *
 * Padrão é DRY-RUN. Pra valer: --aplicar
 *   npx tsx scripts/recuperar-leads-apagao.ts <locationId> <desdeISO> [--aplicar]
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const LOC = process.argv[2] ?? "A62s5EQj1hldOuvBEowv";
const DESDE = process.argv[3] ?? "2026-09-22T01:50:00Z";
const APLICAR = process.argv.includes("--aplicar");

(async () => {
  const { data: falhas } = await sb.from("execution_log")
    .select("contact_id,created_at").eq("location_id", LOC)
    .eq("action_type", "send_message").eq("success", false)
    .gte("created_at", DESDE).order("created_at").limit(500);
  const ids = [...new Set((falhas ?? []).map((r) => r.contact_id))];

  const recuperaveis: Array<{ id: string; msgId: string; texto: string; quando: string }> = [];
  for (const id of ids) {
    // Já foi atendido DEPOIS do apagão? Então não mexe — ou o lead voltou, ou
    // um humano assumiu; reabrir seria a IA falando por cima.
    const { data: ok } = await sb.from("execution_log")
      .select("created_at").eq("contact_id", id).eq("action_type", "send_message")
      .eq("success", true).gte("created_at", DESDE).limit(1);
    if (ok?.length) continue;

    const { data: msgs } = await sb.from("message_queue")
      .select("id,message_body,received_at,status").eq("contact_id", id)
      .order("received_at", { ascending: false }).limit(1);
    const m = msgs?.[0];
    if (!m || m.status !== "completed") continue;
    recuperaveis.push({ id, msgId: m.id, texto: (m.message_body ?? "").replace(/\s+/g, " ").slice(0, 70), quando: m.received_at });
  }

  console.log(`\nleads com resposta não entregue desde ${DESDE}: ${ids.length}`);
  console.log(`RECUPERÁVEIS (ninguém falou com eles depois): ${recuperaveis.length}\n`);
  for (const r of recuperaveis) console.log(`  ${r.quando.slice(5, 16)}  ${r.id}  ${JSON.stringify(r.texto)}`);

  if (!APLICAR) { console.log(`\n(DRY-RUN — nada mudou. Pra valer: --aplicar)`); return; }

  const { error } = await sb.from("message_queue")
    .update({ status: "pending", process_after: new Date().toISOString() })
    .in("id", recuperaveis.map((r) => r.msgId));
  if (error) { console.error("FALHOU:", error.message); process.exit(1); }
  console.log(`\n${recuperaveis.length} conversa(s) devolvida(s) pra fila — a IA responde no próximo tick (10s).`);
})();
