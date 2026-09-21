/**
 * Reconstrói as conversas reais de uma location (lead + IA) num arquivo legível.
 *
 * O inbound do lead vive em `message_queue`; a saída da IA vive no
 * `action_payload` do `send_message` do `execution_log`. Junta os dois pela
 * linha do tempo — é o mais perto de "ler a conversa" que dá sem o CRM.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const LOC = process.argv[2] ?? "A62s5EQj1hldOuvBEowv";
const DIAS = Number(process.argv[3] ?? 7);
const SAIDA = process.argv[4] ?? "_planning/marina-review-2026-09-21/conversas.txt";

type Ev = { t: string; quem: string; texto: string; meta?: string };

(async () => {
  const desde = new Date(Date.now() - DIAS * 864e5).toISOString();

  // O PostgREST corta em 1000 linhas por resposta, INDEPENDENTE do .limit() que
  // você pedir — e como a ordem é crescente, o que se perde é sempre o fim da
  // janela. Um dump assim parece "a IA ficou muda a partir do dia X": foi
  // exatamente essa a leitura errada na primeira rodada. Sempre paginar.
  async function tudo<T>(tabela: string, cols: string, colData: string): Promise<T[]> {
    const out: T[] = [];
    const PAG = 1000;
    for (let de = 0; ; de += PAG) {
      const { data, error } = await sb.from(tabela).select(cols)
        .eq("location_id", LOC).gte(colData, desde)
        .order(colData, { ascending: true }).range(de, de + PAG - 1);
      if (error) throw new Error(`${tabela}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < PAG) break;
    }
    return out;
  }
  const inb = await tudo<any>("message_queue", "contact_id,message_body,received_at,channel,status,message_direction", "received_at");
  const logs = await tudo<any>("execution_log", "contact_id,action_type,action_payload,created_at,success,error_message", "created_at");
  console.log(`inbound=${inb.length} eventos=${logs.length}`);

  const porC: Record<string, Ev[]> = {};
  for (const m of inb ?? []) {
    (porC[m.contact_id] ??= []).push({
      t: m.received_at, quem: "LEAD",
      texto: (m.message_body ?? "").replace(/\s+/g, " ").trim(),
      meta: m.status !== "completed" ? `status=${m.status}` : undefined,
    });
  }
  for (const l of logs ?? []) {
    const p: any = l.action_payload ?? {};
    if (l.action_type === "send_message") {
      const partes: string[] = Array.isArray(p.message) ? p.message : [String(p.message ?? "")];
      (porC[l.contact_id] ??= []).push({
        t: l.created_at, quem: l.success ? "IA" : "IA-NAO-ENTREGUE",
        texto: partes.join("  ⏎ "),
        meta: l.success ? undefined : `ERRO: ${l.error_message}`,
      });
    } else if (["targeting_skip","ai_paused_skip","should_respond_skip","ai_paused","book_appointment","handoff_notification","entry_suppressed","max_messages_skip"].includes(l.action_type)) {
      (porC[l.contact_id] ??= []).push({
        t: l.created_at, quem: `[${l.action_type}${l.success===false?"/FALHOU":""}]`,
        texto: JSON.stringify(p).slice(0, 220), meta: l.error_message ?? undefined,
      });
    }
  }

  const ids = Object.keys(porC).filter(id => porC[id].some(e => e.quem === "LEAD"));
  ids.sort((a,b) => porC[b].length - porC[a].length);
  const linhas: string[] = [];
  linhas.push(`# Conversas — location ${LOC} — últimos ${DIAS} dias — ${ids.length} contatos\n`);
  for (const id of ids) {
    const evs = porC[id].sort((a,b) => a.t.localeCompare(b.t));
    linhas.push(`\n${"=".repeat(78)}\n## contato ${id}  (${evs.length} eventos)\n`);
    for (const e of evs) {
      linhas.push(`[${e.t.slice(5,16).replace("T"," ")}] ${e.quem.padEnd(16)} ${e.texto}${e.meta ? `   <<${e.meta}>>` : ""}`);
    }
  }
  writeFileSync(SAIDA, linhas.join("\n"));
  console.log(`${ids.length} conversas -> ${SAIDA} (${(linhas.join("\n").length/1024).toFixed(0)} KB)`);
})();
