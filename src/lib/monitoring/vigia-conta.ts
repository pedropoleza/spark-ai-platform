/**
 * Vigia de SAÚDE de uma conta lead-facing (H94, 2026-09-21).
 *
 * Nasceu do review da conta da Marina Couto, onde três problemas conviveram por
 * dias sem que nenhuma métrica existente acusasse: a IA respondia (volume OK),
 * a mediana de latência era 0,3 min (latência OK) e mesmo assim o cliente
 * reclamava — porque o que quebrou foi a CAUDA (leads esperando horas), a
 * ENTREGA (token do CRM fora, a IA escrevia e o lead não recebia) e a PORTA DE
 * ENTRADA (regra de ativação barrando lead real).
 *
 * Cada detector aqui é DETERMINÍSTICO e foi rodado contra as conversas reais de
 * 13 a 21/09 antes de entrar — a lição do H85: detector que não foi validado
 * contra corpus de produção encontra o que o autor imaginou, não o que acontece.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface AchadoConta {
  chave: string;
  gravidade: "critico" | "alto" | "medio" | "ok";
  resumo: string;
  detalhe?: unknown;
}

const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Lê tudo (o PostgREST corta em 1000 por resposta — paginar não é opcional). */
async function paginar<T>(
  sb: ReturnType<typeof createAdminClient>,
  tabela: string, cols: string, locationId: string, colData: string, desde: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await sb.from(tabela).select(cols)
      .eq("location_id", locationId).gte(colData, desde)
      .order(colData, { ascending: true }).range(de, de + 999);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Confere pares "dia-da-semana + data" no texto que o lead LEU.
 * O modelo mapeia dia↔data pelo calendário de 2025 (H68) — aqui a data manda.
 */
export function paresDiaDataErrados(texto: string, ano: number): Array<{ trecho: string; real: string }> {
  const erros: Array<{ trecho: string; real: string }> = [];
  const re = /(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)[^.,;!?\n]{0,18}?(\d{1,2})[\/](\d{1,2})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const dito = m[1].toLowerCase().replace("ca", "ça").replace("sabado", "sábado");
    const dia = Number(m[2]), mes = Number(m[3]);
    if (!dia || !mes || mes > 12 || dia > 31) continue;
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    if (d.getUTCMonth() !== mes - 1) continue;
    const real = DIAS_SEMANA[d.getUTCDay()];
    const ditoNorm = dito.startsWith("ter") ? "terça" : dito.startsWith("sáb") ? "sábado" : dito;
    if (ditoNorm !== real) erros.push({ trecho: m[0], real });
  }
  return erros;
}

/** Afirmação de que está marcado, sem agendamento real por trás (classe L11/H58). */
export function afirmaAgendado(texto: string): boolean {
  return /\b(fechado|fechadinho|t[áa] marcado|marcado|agendado|confirmado|garanti(do|do teu lugar)|te coloquei)\b/i.test(texto)
    && !/pra confirmar|pra garantir|me passa|preciso (do|de)/i.test(texto.split(/[.!?\n]/)[0] ?? "");
}

export async function vigiarConta(locationId: string, horas = 24): Promise<{
  locationId: string; horas: number; achados: AchadoConta[];
}> {
  const sb = createAdminClient();
  const desde = new Date(Date.now() - horas * 36e5).toISOString();
  const achados: AchadoConta[] = [];

  interface LinhaLog {
    contact_id: string; action_type: string; created_at: string;
    success: boolean | null; error_message: string | null;
    action_payload: { message?: string | string[] } | null;
  }
  interface LinhaFila {
    contact_id: string; message_body: string | null; received_at: string;
    process_after: string | null; updated_at: string | null; status: string;
  }
  const logs = await paginar<LinhaLog>(sb, "execution_log",
    "contact_id,action_type,action_payload,created_at,success,error_message", locationId, "created_at", desde);
  const fila = await paginar<LinhaFila>(sb, "message_queue",
    "contact_id,message_body,received_at,process_after,updated_at,status", locationId, "received_at", desde);

  // 1. ENTREGA — a IA escreveu e o lead recebeu?
  const envios = logs.filter((l) => l.action_type === "send_message");
  const falhos = envios.filter((l) => l.success === false);
  const pctFalha = envios.length ? (100 * falhos.length) / envios.length : 0;
  achados.push({
    chave: "entrega",
    gravidade: pctFalha >= 20 ? "critico" : pctFalha >= 5 ? "alto" : "ok",
    resumo: `${falhos.length} de ${envios.length} respostas não chegaram ao lead (${pctFalha.toFixed(1)}%)`,
    detalhe: falhos.length ? { erros: [...new Set(falhos.map((f) => (f.error_message ?? "").slice(0, 90)))] } : undefined,
  });

  // 2. CAUDA DA FILA — a mediana engana; o que gera reclamação é o p90.
  const atrasos = fila
    .filter((m) => m.status === "completed" && m.updated_at)
    .map((m) => Math.max(0, (new Date(m.updated_at as string).getTime() - new Date(m.process_after ?? m.received_at).getTime()) / 60000))
    .sort((a, b) => a - b);
  const q = (p: number) => atrasos[Math.floor(atrasos.length * p)] ?? 0;
  const acima1h = atrasos.filter((a) => a > 60).length;
  achados.push({
    chave: "cauda_fila",
    gravidade: acima1h >= 3 ? "critico" : acima1h >= 1 || q(0.9) > 10 ? "alto" : "ok",
    resumo: `espera na fila: p50 ${q(0.5).toFixed(1)}min · p90 ${q(0.9).toFixed(1)}min · ${acima1h} acima de 1h (${atrasos.length} msgs)`,
  });

  // 3. PORTA DE ENTRADA — quem foi barrado parecia lead de verdade?
  const barrados = [...new Set(logs.filter((l) => l.action_type === "targeting_skip").map((l) => l.contact_id))];
  const primeira: Record<string, string> = {};
  for (const m of fila) if (!primeira[m.contact_id]) primeira[m.contact_id] = (m.message_body ?? "").replace(/\s+/g, " ").trim();
  const PARABENS = /parab[ée]ns|happy birth|felicidades|feliz anivers|🎂|🥳|🎉/i;
  const LEAD_REAL = /informa|saber mais|conhecer|como funciona|quero|interesse|trabalh|profiss|permit|green ?card|oportunidade|explica|remunera|vaga/i;
  const leadsBarrados = barrados.filter((id) => !PARABENS.test(primeira[id] ?? "") && LEAD_REAL.test(primeira[id] ?? ""));
  achados.push({
    chave: "porta_de_entrada",
    gravidade: leadsBarrados.length >= 3 ? "alto" : leadsBarrados.length >= 1 ? "medio" : "ok",
    resumo: `${barrados.length} barrados pela ativação, ${leadsBarrados.length} pareciam lead de verdade`,
    detalhe: leadsBarrados.length ? { exemplos: leadsBarrados.slice(0, 5).map((id) => primeira[id]?.slice(0, 70)) } : undefined,
  });

  // 4. QUALIDADE do texto entregue: data errada e "fechado" sem agendamento.
  const ano = new Date().getUTCFullYear();
  const agendou = new Set(
    logs.filter((l) => l.action_type === "book_appointment" && l.success !== false).map((l) => l.contact_id),
  );
  const errosData: Array<{ contato: string; quando: string; disse: string; real: string }> = [];
  const falsoFechado: Array<{ contato: string; quando: string; texto: string }> = [];
  for (const l of envios.filter((e) => e.success !== false)) {
    const partes: string[] = Array.isArray(l.action_payload?.message) ? l.action_payload.message : [String(l.action_payload?.message ?? "")];
    const texto = partes.join(" ");
    for (const e of paresDiaDataErrados(texto, ano)) {
      errosData.push({ contato: l.contact_id, quando: l.created_at, disse: e.trecho, real: e.real });
    }
    if (afirmaAgendado(texto) && !agendou.has(l.contact_id)) {
      falsoFechado.push({ contato: l.contact_id, quando: l.created_at, texto: texto.slice(0, 110) });
    }
  }
  achados.push({
    chave: "dia_data",
    gravidade: errosData.length ? "critico" : "ok",
    resumo: errosData.length ? `${errosData.length} par(es) dia/data ERRADOS no texto que o lead leu` : "nenhum par dia/data errado",
    detalhe: errosData.slice(0, 5),
  });
  achados.push({
    chave: "falso_fechado",
    gravidade: falsoFechado.length ? "critico" : "ok",
    resumo: falsoFechado.length ? `${falsoFechado.length} conversa(s) onde a IA disse que estava marcado SEM agendamento real` : "nenhuma confirmação falsa",
    detalhe: falsoFechado.slice(0, 5),
  });

  // 5. VOLUME — conta viva?
  const agendamentos = logs.filter((l) => l.action_type === "book_appointment" && l.success !== false).length;
  const atendidos = new Set(logs.filter((l) => l.action_type === "ai_processing").map((l) => l.contact_id)).size;
  achados.push({
    chave: "volume",
    gravidade: atendidos === 0 && fila.length > 0 ? "critico" : "ok",
    resumo: `${atendidos} contatos atendidos, ${agendamentos} agendamento(s), ${fila.length} mensagens recebidas`,
  });

  return { locationId, horas, achados };
}
