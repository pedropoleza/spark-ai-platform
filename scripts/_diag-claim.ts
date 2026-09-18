/**
 * READ-ONLY-ish: testa se o CLAIM do queue-processor funciona como o código espera.
 * O claim é UPDATE ... eq(status) .lte(process_after) .select() .order() .limit(100).
 * Se o PostgREST recusar order/limit em UPDATE, o código engole (fetchError) e
 * devolve processed:0 em silêncio.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // 1) SELECT equivalente — quantas linhas o claim DEVERIA pegar agora
  const { data: sel, error: selErr } = await sb
    .from("message_queue").select("id")
    .eq("status", "pending").lte("process_after", new Date().toISOString())
    .order("received_at", { ascending: true }).limit(100);
  console.log("SELECT equivalente:", selErr ? `ERRO ${selErr.message}` : `${sel?.length ?? 0} linha(s)`);

  // 2) O UPDATE com order+limit é aceito? Teste INÓCUO: mexe em linha já
  //    'completed' setando retry_count pro valor que ela já tem.
  const { data: alvo } = await sb
    .from("message_queue").select("id, retry_count")
    .eq("status", "completed").order("received_at", { ascending: false }).limit(1);
  if (!alvo?.length) { console.log("sem linha pra testar"); return; }

  const { data: upd, error: updErr } = await sb
    .from("message_queue")
    .update({ retry_count: alvo[0].retry_count ?? 0 })
    .eq("id", alvo[0].id)
    .eq("status", "completed")
    .lte("process_after", new Date().toISOString())
    .select("*")
    .order("received_at", { ascending: true })
    .limit(100);

  if (updErr) {
    console.log("❌ UPDATE+order+limit REJEITADO:", updErr.code, updErr.message);
    console.log("   → É ISSO: o claim falha e o código devolve processed:0 calado.");
  } else {
    console.log(`✅ UPDATE+order+limit aceito (${upd?.length ?? 0} linha(s) devolvida(s))`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
