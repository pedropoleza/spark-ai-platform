/**
 * Teste do branch "fila presa" do vigia (H92). Insere uma mensagem vencida numa
 * location FICTÍCIA (sem agente ativo → o processador só descarta, nenhum lead
 * real é tocado) e chama o vigia NO MESMO INSTANTE, antes do cron de 10s pegar.
 * Limpa no fim, sempre.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });

const LOC = "ZZ-TESTE-H92";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const secret = process.env.CRON_SECRET!;
  const base = "https://spark-ai-platform.vercel.app";
  let ok = 0, bad = 0;
  const chk = (n: string, c: boolean, d = "") => { console.log((c ? "  ✅ " : "  ❌ ") + n + (c ? "" : " — " + d)); c ? ok++ : bad++; };

  await sb.from("message_queue").delete().eq("location_id", LOC);

  const marca = Date.now();
  const { error: insErr } = await sb.from("message_queue").insert({
    location_id: LOC, contact_id: "contato-teste-h92", conversation_id: "conv-teste",
    message_body: "teste vigia", message_type: "SMS", message_direction: "inbound",
    ghl_message_id: `teste-h92-${marca}`,
    received_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    process_after: new Date(Date.now() - 10 * 60_000).toISOString(),
    status: "pending", channel: "SMS",
  });
  if (insErr) throw new Error("insert falhou: " + insErr.message);

  // chama o vigia IMEDIATAMENTE (corrida com o cron de 10s)
  const r = await fetch(`${base}/api/cron/vigia-fila?modo=fila`, { headers: { Authorization: `Bearer ${secret}` } });
  const j = await r.json() as { presas: number; drenou: boolean; processadas_no_dreno: number; mais_antiga_min: number | null };
  console.log("  resposta:", JSON.stringify(j));

  if (j.presas > 0) {
    chk("detectou a mensagem presa", true);
    chk("calculou a idade da mais antiga", (j.mais_antiga_min ?? 0) >= 9, `${j.mais_antiga_min}min`);
    chk("acionou o dreno (auto-cura)", j.drenou === true);
  } else {
    console.log("  (o cron de 10s pegou antes — testando só que o vigia não inventa alarme)");
    chk("não reporta presa quando a fila está limpa", j.presas === 0);
  }

  // a mensagem tem que ter saído de 'pending' de um jeito ou de outro
  const { data: fim } = await sb.from("message_queue").select("status").eq("location_id", LOC);
  chk("mensagem saiu de pending", (fim || []).every((m) => m.status !== "pending"), JSON.stringify(fim));

  await sb.from("message_queue").delete().eq("location_id", LOC);
  const { count } = await sb.from("message_queue").select("id", { count: "exact", head: true }).eq("location_id", LOC);
  chk("limpeza do teste", (count ?? 0) === 0);

  console.log("\n" + (bad === 0 ? "✅" : "❌") + ` ${ok}/${ok + bad}`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("ERR:", e?.message || e); process.exit(1); });
