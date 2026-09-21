/**
 * H94 — prova que o processador DEVOLVE o que não vai dar tempo de atender,
 * em vez de deixar preso em 'processing' esperando o reaper de 5 min.
 *
 * Roda contra o banco de PRODUÇÃO porque o claim é fleet-wide e é justamente o
 * comportamento do claim que está sob teste. Usa uma location fictícia: sem
 * agente ativo, o processGroup retorna na hora, então as linhas de teste não
 * disparam LLM nem tocam CRM nenhum. Mensagens REAIS que porventura sejam
 * devolvidas junto não sofrem nada — voltam pra 'pending' já elegíveis e o
 * tick de 10s pega.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";
import { processMessageQueue } from "../src/lib/queue/queue-processor";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const LOC = "ZZ-TESTE-H94";
let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, detalhe = "") => {
  if (cond) { ok++; console.log(`  PASS  ${nome}`); }
  else { fail++; console.log(`  FALHA ${nome} ${detalhe}`); }
};

async function semear(n: number) {
  const linhas = Array.from({ length: n }, (_, i) => ({
    location_id: LOC,
    contact_id: `zz-contato-${i}`,
    conversation_id: `zz-conv-${i}`,
    message_body: `teste h94 #${i}`,
    message_type: "SMS",
    message_direction: "inbound",
    ghl_message_id: `zz-h94-${Date.now()}-${i}`,
    received_at: new Date(Date.now() - 60_000).toISOString(),
    process_after: new Date(Date.now() - 30_000).toISOString(),
    status: "pending",
    channel: "SMS",
  }));
  const { error } = await sb.from("message_queue").insert(linhas);
  if (error) throw new Error(`seed: ${error.message}`);
}
const estado = async () => {
  const { data } = await sb.from("message_queue").select("status").eq("location_id", LOC);
  const c: Record<string, number> = {};
  for (const r of data ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
};
const limpar = () => sb.from("message_queue").delete().eq("location_id", LOC);

(async () => {
  await limpar();
  console.log("\n=== CENÁRIO 1: orçamento ESGOTADO -> tem que DEVOLVER ===");
  await semear(6);
  const r1 = await processMessageQueue({ orcamentoMs: 1 });
  const e1 = await estado();
  console.log(`  retorno: ${JSON.stringify(r1)} | estado: ${JSON.stringify(e1)}`);
  t("nenhum grupo processado", r1.processed === 0, `processed=${r1.processed}`);
  t("devolveu alguma coisa", (r1.devolvidas ?? 0) > 0, `devolvidas=${r1.devolvidas}`);
  t("as 6 voltaram pra pending", (e1.pending ?? 0) === 6, JSON.stringify(e1));
  t("NENHUMA ficou presa em processing", !e1.processing, JSON.stringify(e1));

  const { data: aud } = await sb.from("execution_log").select("action_payload,created_at")
    .eq("action_type", "queue_lote_devolvido").order("created_at", { ascending: false }).limit(1);
  t("gravou auditoria queue_lote_devolvido", !!aud?.length,
    aud?.length ? JSON.stringify(aud[0].action_payload) : "nenhuma linha");

  console.log("\n=== CENÁRIO 2: orçamento FOLGADO -> tem que PROCESSAR ===");
  const r2 = await processMessageQueue({ orcamentoMs: 40_000 });
  const e2 = await estado();
  console.log(`  retorno: ${JSON.stringify(r2)} | estado: ${JSON.stringify(e2)}`);
  t("processou os grupos de teste", r2.processed >= 6, `processed=${r2.processed}`);
  t("nada devolvido com folga", !r2.devolvidas, `devolvidas=${r2.devolvidas}`);
  t("todas concluídas", (e2.completed ?? 0) === 6, JSON.stringify(e2));
  t("nada preso em processing", !e2.processing, JSON.stringify(e2));

  console.log("\n=== CENÁRIO 3: sem orçamento = comportamento antigo ===");
  await limpar(); await semear(3);
  const r3 = await processMessageQueue();
  const e3 = await estado();
  t("processa tudo sem teto", r3.processed >= 3 && !r3.devolvidas, JSON.stringify(r3));
  t("nada preso", !e3.processing, JSON.stringify(e3));

  await limpar();
  const fim = await estado();
  t("limpou as linhas de teste", Object.keys(fim).length === 0, JSON.stringify(fim));
  console.log(`\n${ok}/${ok + fail} passaram`);
  process.exit(fail ? 1 : 0);
})();
