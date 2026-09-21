/**
 * Vigia da FILA e da LATÊNCIA (H92, 2026-09-18 — pedido do Pedro depois de duas
 * reclamações no mesmo dia: "a IA não tá respondendo" na Marina e "o bot não tá
 * agendando" na Horizon).
 *
 * As duas reclamações tinham a MESMA raiz e nenhuma delas era o que parecia: a
 * IA respondia, e respondia certo — só que tarde. A mediana das duas contas é de
 * SEGUNDOS; o que dói é a CAUDA. Medido em 7 dias:
 *   Horizon        p50 1min · p90 46min · 13,5% acima de 10min
 *   Marina Support p50 0min · p90  1min ·  5,9% acima de 10min · 32 casos >1h
 *
 * Por que ninguém viu antes: o painel só enxergava conta MUDA (H89). Conta que
 * responde em 4 horas está "funcionando" por qualquer métrica de volume — e é
 * exatamente a que faz o cliente reclamar, porque o lead já esfriou.
 *
 * Dois vigias aqui, com propósitos diferentes:
 *
 *  1. `vigiarFilaParada()` — alta frequência. Olha o AGORA: mensagem vencida
 *     esperando. Além de alertar, FORÇA o dreno (auto-cura) — a causa da cauda
 *     ainda não está 100% isolada, mas o lead não pode pagar a conta da
 *     investigação. Padrão do H69: quem depende de gatilho externo precisa de
 *     uma rede que pergunte "já venceu e ainda não saiu?".
 *
 *  2. `vigiarLatencia()` — diário. Olha o HISTÓRICO por conta e compara com o
 *     próprio passado dela. É o que responde "a correção funcionou mesmo?".
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSignal } from "@/lib/admin-signals/recorder";

/** Vencida há mais que isso = parada de verdade (não é debounce nem jitter). */
const PARADA_MIN = 4;
/** Acima disso, o lead percebe que ninguém respondeu. */
const LENTA_MIN = 10;
/** % de mensagens lentas que caracteriza conta degradada. */
const PCT_LENTAS_ALERTA = 10;
/** Amostra mínima pra não gritar com conta de 3 mensagens. */
const AMOSTRA_MINIMA = 15;

export interface FilaParada {
  presas: number;
  mais_antiga_min: number | null;
  locations: string[];
  drenou: boolean;
  processadas_no_dreno: number;
}

/**
 * Procura mensagem vencida parada, força o dreno e alerta se sobrar.
 * Fail-soft: nunca lança — é rede de segurança, não pode virar o problema.
 */
export async function vigiarFilaParada(forcarDreno = true): Promise<FilaParada> {
  const sb = createAdminClient();
  const corte = new Date(Date.now() - PARADA_MIN * 60_000).toISOString();

  const { data: presas } = await sb
    .from("message_queue")
    .select("id, location_id, process_after")
    .eq("status", "pending")
    .lte("process_after", corte)
    .order("process_after", { ascending: true })
    .limit(200);

  const lista = presas || [];
  const resultado: FilaParada = {
    presas: lista.length,
    mais_antiga_min: lista.length
      ? Math.round((Date.now() - new Date(lista[0].process_after as string).getTime()) / 60_000)
      : null,
    locations: [...new Set(lista.map((m) => m.location_id as string))],
    drenou: false,
    processadas_no_dreno: 0,
  };

  if (lista.length === 0) return resultado;

  // AUTO-CURA: dreno imediato. Roda ANTES do alerta de propósito — se o dreno
  // resolve, o alerta sai como "resolvido sozinho" e não acorda ninguém à toa.
  if (forcarDreno) {
    try {
      const { processMessageQueue } = await import("@/lib/queue/queue-processor");
      // H94: mesmo teto por dentro do dreno forçado.
      const r = await processMessageQueue({ orcamentoMs: 40_000 });
      resultado.drenou = true;
      resultado.processadas_no_dreno = r.processed;
    } catch (e) {
      console.error("[vigia-fila] dreno forçado falhou:", e instanceof Error ? e.message : e);
    }
  }

  // Ainda preso DEPOIS do dreno = problema de verdade.
  const { count: aindaPresas } = await sb
    .from("message_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("process_after", corte);

  const sobrou = aindaPresas ?? 0;
  if (sobrou > 0) {
    await recordSignal({
      type: "failure",
      title: `Fila lead-facing parada: ${sobrou} mensagem(ns) vencida(s) após dreno forçado`,
      description:
        `${sobrou} mensagem(ns) já venceram o debounce e continuam sem processar mesmo depois ` +
        `de um dreno manual. A mais antiga espera há ${resultado.mais_antiga_min} min. ` +
        `Locations: ${resultado.locations.join(", ")}. Lead esperando resposta.`,
      severity: (resultado.mais_antiga_min ?? 0) > 30 ? "critical" : "high",
      source: "bot_auto",
      metadata: { feature: "vigia-fila", ...resultado, ainda_presas: sobrou },
    });
  }

  return resultado;
}

export interface LatenciaConta {
  location_id: string;
  location_name: string | null;
  amostra: number;
  p50_min: number;
  p90_min: number;
  lentas: number;
  pct_lentas: number;
  pior_min: number;
  sem_resposta_sem_motivo: number;
}

export interface ResultadoLatencia {
  verificadas: number;
  degradadas: LatenciaConta[];
  sinais_emitidos: number;
  todas: LatenciaConta[];
}

/**
 * Mede a latência por conta nas últimas 24h e alerta nas degradadas.
 *
 * Silêncio COM motivo registrado (`ai_paused` porque um humano assumiu,
 * `targeting_skip`, `deactivated_by_rule_skip`, `entry_suppressed`) NÃO conta
 * como falha — foi a distinção que separou "o bot não tá agendando" de um bug
 * real na Horizon, onde os 23 silêncios do dia tinham todos motivo legítimo.
 */
export async function vigiarLatencia(emitirSinais = true, horas = 24): Promise<ResultadoLatencia> {
  const sb = createAdminClient();
  const { data, error } = await sb.rpc("medir_latencia_resposta", { p_horas: horas });
  if (error) throw new Error(`medir_latencia_resposta falhou: ${error.message}`);

  const linhas = (data || []) as Array<{
    location_id: string;
    location_name: string | null;
    amostra: number;
    p50_min: number;
    p90_min: number;
    lentas: number;
    pior_min: number;
    sem_resposta_sem_motivo: number;
  }>;

  const todas: LatenciaConta[] = linhas.map((l) => ({
    ...l,
    pct_lentas: l.amostra > 0 ? Math.round((1000 * l.lentas) / l.amostra) / 10 : 0,
  }));

  const degradadas = todas.filter(
    (c) => c.amostra >= AMOSTRA_MINIMA && (c.pct_lentas >= PCT_LENTAS_ALERTA || c.p90_min >= LENTA_MIN),
  );

  let sinais = 0;
  if (emitirSinais) {
    for (const c of degradadas) {
      await recordSignal({
        type: "failure",
        title: `Latência degradada: ${c.location_name || c.location_id} responde em até ${c.p90_min}min`,
        description:
          `Nas últimas ${horas}h, ${c.pct_lentas}% dos leads (${c.lentas} de ${c.amostra}) esperaram mais de ` +
          `${LENTA_MIN} min pela resposta. p50 ${c.p50_min}min · p90 ${c.p90_min}min · pior ${c.pior_min}min. ` +
          `A conta NÃO está muda — está lenta, que é o que faz o cliente reclamar sem aparecer em métrica de volume.`,
        severity: c.p90_min >= 60 ? "high" : "medium",
        source: "bot_auto",
        metadata: { feature: "vigia-latencia", ...c },
      });
      sinais++;
    }
  }

  return { verificadas: todas.length, degradadas, sinais_emitidos: sinais, todas };
}
