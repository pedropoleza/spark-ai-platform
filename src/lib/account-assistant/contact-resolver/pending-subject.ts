/**
 * "Assunto pendente" — a pessoa que o rep ACABOU de apresentar e que ainda NÃO
 * existe no CRM (H59, caso Paulo Abreu 2026-07-29).
 *
 * ── O buraco que isto fecha ─────────────────────────────────────────────────
 * Todo o mecanismo de "contato em foco" (H45) é chaveado em `contact_id` — um id
 * do CRM. Consequência: uma pessoa que o rep apresenta AGORA e que ainda não foi
 * cadastrada simplesmente NÃO EXISTE pro sistema de contexto. Foi o caso Paulo
 * Abreu: o rep mandou o cartão dele, o bot leu, buscou, não achou no CRM — e no
 * turno seguinte não fazia ideia de quem era ("com quem é a demo?"), mesmo o rep
 * tendo respondido "sim" à pergunta que o próprio bot fez.
 *
 * Pior: com o foco vazio, o `getActiveContactContext` promovia `recent[0]` — um
 * contato de OUTRA conversa — a "contato em jogo agora". Foi assim que a Bianca
 * Amorim apareceu do nada no meio de uma conversa sobre o Paulo. Os dois
 * sintomas ("perdeu o contexto" e "alucinou outro contato") são o MESMO defeito:
 * o vácuo deixado por quem não tem id sendo preenchido pelo passado.
 *
 * ── Como funciona ──────────────────────────────────────────────────────────
 * O assunto é extraído do que o turno FEZ (tool_calls persistidos), nunca de
 * inferência sobre o texto: o termo que o bot buscou em `search_contacts` e os
 * dados que ele tentou gravar em `create_contact` são fonte REAL do que estava
 * em jogo. Fica válido por uma janela curta e é descartado assim que a pessoa
 * vira contato de verdade (aí o mecanismo do H45 assume).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Janela em que "acabei de apresentar essa pessoa" ainda faz sentido. */
const JANELA_MS = 60 * 60 * 1000; // 1h

export interface PendingSubject {
  /** Nome como o rep/bot o escreveu. */
  name?: string;
  /** Telefone, quando apareceu na busca/criação. */
  phone?: string;
  /** Quando entrou em jogo. */
  when?: string;
  /** De onde saiu: busca sem resultado, ou tentativa de criação. */
  via: "search_miss" | "create_attempt";
}

type ToolCall = { name?: unknown; input?: unknown; result_preview?: unknown };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Um telefone plausível dentro de um texto qualquer (≥8 dígitos). */
function acharTelefone(...textos: string[]): string {
  for (const t of textos) {
    const m = (t || "").match(/\+?[\d][\d\s().-]{7,}\d/);
    if (m) {
      const digitos = m[0].replace(/\D/g, "");
      if (digitos.length >= 8) return m[0].trim();
    }
  }
  return "";
}

/** O `result_preview` indica que a busca NÃO achou ninguém? */
function buscaVazia(preview: string): boolean {
  const p = preview.toLowerCase();
  if (/"?confidence"?\s*:\s*"?(low|none)/.test(p)) return true;
  if (/"?(total|count|results?_count)"?\s*:\s*0\b/.test(p)) return true;
  if (/\[\s*\]/.test(p) && /contact/.test(p)) return true;
  return /nao encontr|não encontr|not found|nenhum contato/.test(p);
}

/**
 * Extrai o assunto pendente de UMA lista de tool_calls. Puro — testável sem DB.
 *
 * `create_contact` ganha de `search_contacts`: tentar criar é sinal mais forte
 * de "é dessa pessoa que estamos falando" do que ter buscado.
 */
export function extractPendingSubject(toolCalls: unknown, when?: string): PendingSubject | null {
  if (!Array.isArray(toolCalls)) return null;
  let doBusca: PendingSubject | null = null;

  for (const raw of toolCalls as ToolCall[]) {
    const nome = str(raw?.name);
    const input = (raw?.input || {}) as Record<string, unknown>;
    const preview = str(raw?.result_preview);

    if (nome === "create_contact") {
      const n =
        str(input.name) ||
        [str(input.first_name), str(input.last_name)].filter(Boolean).join(" ").trim();
      const tel = str(input.phone) || acharTelefone(JSON.stringify(input));
      if (n || tel) return { name: n || undefined, phone: tel || undefined, when, via: "create_attempt" };
    }

    if (nome === "search_contacts" && !doBusca && buscaVazia(preview)) {
      const termo = str(input.query) || str(input.name) || str(input.search) || str(input.term);
      const tel = str(input.phone) || acharTelefone(termo, preview);
      // Termo que é só telefone não vira "nome".
      const ehSoTelefone = termo && termo.replace(/[\d\s+().-]/g, "").length === 0;
      if (termo || tel) {
        doBusca = {
          name: ehSoTelefone ? undefined : termo || undefined,
          phone: tel || (ehSoTelefone ? termo : undefined),
          when,
          via: "search_miss",
        };
      }
    }
  }
  return doBusca;
}

/**
 * Procura, nos turnos recentes do rep, uma pessoa que entrou em jogo e ainda não
 * virou contato. Fail-soft: erro → null (comportamento de antes).
 */
export async function getPendingSubject(
  supabase: SupabaseClient,
  repId: string,
  opts: { hubLocationId?: string | null } = {},
): Promise<PendingSubject | null> {
  try {
    const desde = new Date(Date.now() - JANELA_MS).toISOString();
    let q = supabase
      .from("sparkbot_messages")
      .select("metadata, created_at")
      .eq("rep_id", repId)
      .eq("role", "agent")
      .gte("created_at", desde)
      .order("created_at", { ascending: false })
      .limit(8);
    if (opts.hubLocationId) q = q.eq("hub_location_id", opts.hubLocationId);
    const r = await q;
    const rows = (r.data || []) as Array<{ metadata?: Record<string, unknown>; created_at?: string }>;
    for (const row of rows) {
      // Se um turno recente JÁ resolveu um contato de verdade, o assunto
      // pendente morreu ali — quem manda a partir daí é o foco do H45.
      if (typeof row.metadata?.contact_id === "string" && row.metadata.contact_id) return null;
      const achado = extractPendingSubject(row.metadata?.tool_calls, row.created_at);
      if (achado) return achado;
    }
  } catch {
    // fail-soft
  }
  return null;
}

/** Bloco pro runtime context. Vazio quando não há assunto pendente. */
export function renderPendingSubjectBlock(s: PendingSubject | null): string {
  if (!s || (!s.name && !s.phone)) return "";
  const quem = [s.name, s.phone && `(${s.phone})`].filter(Boolean).join(" ");
  return [
    "# PESSOA EM JOGO AGORA (ainda NÃO está no Spark Leads)",
    `O rep te apresentou **${quem}** nos últimos minutos e a busca no Spark Leads não achou ninguém.`,
    `É DESSA pessoa que a conversa trata. Se o rep disser "sim", "cria", "marca", "ele/ela" sem nomear outro, é ${s.name || "essa pessoa"}.`,
    `NUNCA pergunte "com quem é?" enquanto isso valer — você já sabe. E NUNCA troque por um contato de outra conversa.`,
  ].join("\n");
}
