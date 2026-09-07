/**
 * Vigia de contas mudas (H89, 2026-09-07 — pedido do Pedro depois do caso Jussara).
 *
 * O caso Jussara: o agente lead-facing foi pra `inactive` em 23/08 e a conta ficou
 * 12 dias sem responder lead nenhum, até a cliente reclamar no grupo de suporte.
 * O webhook descarta o inbound ANTES de enfileirar quando não há agente ativo, então
 * não sobra rastro nenhum — nem fila, nem execution_log, nem sinal. O sinal novo do
 * webhook cobre esse caso NA HORA, mas só dispara se chegar mensagem.
 *
 * Esta varredura é a rede de baixo, e pergunta a coisa mais útil de todas:
 * **a conta parou de responder do jeito que respondia antes?**
 *
 * Duas classes, com gravidades diferentes:
 *
 *  1. ESCURA — a location tem agente lead-facing cadastrado, NENHUM ativo, e tem
 *     histórico real. Alguém desligou (de propósito ou não) e ninguém voltou.
 *     Foi o caso Jussara e o caso Liberty Financial.
 *
 *  2. MUDA COM AGENTE LIGADO — o agente está `active`, a conta tinha volume, e
 *     zerou. Essa é a classe que o sinal do webhook NÃO pega, porque o inbound nem
 *     está chegando (webhook quebrado, token do Spark Leads vencido, canal
 *     desconectado) ou está sendo barrado depois (working_hours com schedule vazio,
 *     targeting apertado demais, wallet). É a mais grave: a conta se dá por ligada.
 *
 * A comparação é sempre contra o PRÓPRIO passado da conta (média dos 30 dias
 * anteriores à última semana), nunca contra um número absoluto — conta pequena
 * não pode virar ruído permanente, e conta grande que cai pela metade tem que doer.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSignal } from "@/lib/admin-signals/recorder";

/** Mensagens processadas na vida pra location contar como "já funcionou". */
const HIST_MINIMO = 50;
/** Dias sem NADA pra considerar que parou (2 = tolera fim de semana curto). */
const DIAS_PARA_ESCURA = 2;
/** Volume mínimo na janela de baseline pra exigir atividade na semana. */
const BASELINE_MINIMO = 20;
/**
 * Dias DISTINTOS com atividade no baseline pra conta contar como "regular".
 *
 * Calibrado contra produção 2026-09-07, e a 1ª execução derrubou o desenho
 * anterior: só com volume total (43 msgs/30d) a conta da Yolanda apareceu como
 * "muda há 4 dias" — mas ela é INTERMITENTE por natureza (nada entre 12/08 e
 * 02/09, e isso é normal lá). Volume não distingue conta regular de conta em
 * rajada; dias distintos distingue. A Jussara tinha atividade em ~30 dias de 30;
 * a Yolanda, em 4. Só quem some TENDO rotina vira alarme.
 */
const DIAS_ATIVOS_MINIMO = 10;

const TIPOS_LEAD = ["sales_agent", "recruitment_agent", "custom_agent"] as const;

export interface ContaMuda {
  location_id: string;
  location_name: string | null;
  classe: "escura" | "muda_com_agente_ligado";
  agentes: Array<{ id: string; name: string | null; status: string; updated_at: string | null }>;
  off_since: string | null;
  ultima_atividade: string | null;
  dias_parada: number | null;
  msgs_7d: number;
  msgs_baseline_30d: number;
  /** Dias DISTINTOS com atividade no baseline — só preenchido na classe "ligado". */
  dias_ativos_baseline: number;
  historico_total: number;
}

export interface ResultadoVigia {
  ok: boolean;
  verificadas: number;
  achados: ContaMuda[];
  sinais_emitidos: number;
  erro?: string;
}

function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Varre as locations que têm agente lead-facing e devolve as que pararam.
 * `emitirSinais=false` deixa rodar como relatório puro (usado pelo script de CLI).
 */
export async function varrerContasMudas(emitirSinais = true): Promise<ResultadoVigia> {
  const db = createAdminClient();

  const { data: agentes, error: erroAgentes } = await db
    .from("agents")
    .select("id, location_id, name, type, status, updated_at")
    .in("type", TIPOS_LEAD as unknown as string[]);

  if (erroAgentes) return { ok: false, verificadas: 0, achados: [], sinais_emitidos: 0, erro: erroAgentes.message };

  // Agrupa por location — uma conta pode ter vendas + recrutamento.
  const porLocation = new Map<string, typeof agentes>();
  for (const a of agentes || []) {
    const arr = porLocation.get(a.location_id) || [];
    arr.push(a);
    porLocation.set(a.location_id, arr);
  }

  const agora = Date.now();
  const corte7d = new Date(agora - 7 * 86_400_000).toISOString();
  const corteBaseIni = new Date(agora - 37 * 86_400_000).toISOString();
  const corteBaseFim = corte7d;

  const achados: ContaMuda[] = [];

  for (const [locationId, doLocal] of porLocation) {
    const temAtivo = doLocal.some((a) => a.status === "active");

    // Histórico total: prova de que a conta já rodou de verdade. Location nova
    // (ou de teste) não pode gerar alarme por nunca ter tido movimento.
    const { count: historico } = await db
      .from("message_queue")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId);

    if ((historico ?? 0) < HIST_MINIMO) continue;

    const { count: msgs7d } = await db
      .from("message_queue")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .gte("created_at", corte7d);

    const { count: msgsBase } = await db
      .from("message_queue")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .gte("created_at", corteBaseIni)
      .lt("created_at", corteBaseFim);

    const { data: ultima } = await db
      .from("message_queue")
      .select("created_at")
      .eq("location_id", locationId)
      .order("created_at", { ascending: false })
      .limit(1);

    const ultimaAtividade = (ultima?.[0]?.created_at as string | undefined) ?? null;
    const dias = diasDesde(ultimaAtividade);

    const parada = dias !== null && dias >= DIAS_PARA_ESCURA;
    if (!parada) continue;

    // Sem agente ativo = escura. Com agente ativo = pior: ela se dá por ligada.
    const classe: ContaMuda["classe"] = temAtivo ? "muda_com_agente_ligado" : "escura";

    // Agente ligado só vira alarme se a conta tinha ROTINA (volume + regularidade).
    // Conta em rajada fica de fora — ver comentário do DIAS_ATIVOS_MINIMO.
    let diasAtivosBaseline = 0;
    if (classe === "muda_com_agente_ligado") {
      if ((msgsBase ?? 0) < BASELINE_MINIMO) continue;

      const { data: linhasBase } = await db
        .from("message_queue")
        .select("created_at")
        .eq("location_id", locationId)
        .gte("created_at", corteBaseIni)
        .lt("created_at", corteBaseFim)
        .limit(5000);

      diasAtivosBaseline = new Set((linhasBase || []).map((l) => String(l.created_at).slice(0, 10))).size;
      if (diasAtivosBaseline < DIAS_ATIVOS_MINIMO) continue;
    }

    const { data: loc } = await db
      .from("locations")
      .select("location_name")
      .eq("location_id", locationId)
      .maybeSingle();

    // "Desde quando": o desligamento mais recente entre os agentes inativos.
    const offSince =
      doLocal
        .filter((a) => a.status !== "active")
        .map((a) => a.updated_at)
        .filter(Boolean)
        .sort()
        .reverse()[0] ?? null;

    achados.push({
      location_id: locationId,
      location_name: (loc?.location_name as string | undefined) ?? null,
      classe,
      agentes: doLocal.map((a) => ({ id: a.id, name: a.name, status: a.status, updated_at: a.updated_at })),
      off_since: classe === "escura" ? offSince : null,
      ultima_atividade: ultimaAtividade,
      dias_parada: dias,
      msgs_7d: msgs7d ?? 0,
      msgs_baseline_30d: msgsBase ?? 0,
      dias_ativos_baseline: diasAtivosBaseline,
      historico_total: historico ?? 0,
    });
  }

  let sinais = 0;
  if (emitirSinais) {
    for (const c of achados) {
      const nome = c.location_name || c.location_id;
      // Título ESTÁVEL por location (o dedup do recorder é por fingerprint do
      // título) — sem dias/contagem dentro, senão cada dia vira uma linha nova.
      const title =
        c.classe === "escura"
          ? `Conta muda: agente lead-facing desligado e ninguém religou (${c.location_id})`
          : `Conta muda: agente lead-facing ATIVO mas parou de receber mensagem (${c.location_id})`;

      const descricao =
        c.classe === "escura"
          ? `${nome}: todos os agentes lead-facing estão inactive desde ${String(c.off_since).slice(0, 10)} e a conta não processa mensagem há ${c.dias_parada} dias (histórico: ${c.historico_total}). Se a pausa foi de propósito, arquive este sinal.`
          : `${nome}: o agente está ATIVO, mas a conta não processa mensagem há ${c.dias_parada} dias — vinha de ${c.msgs_baseline_30d} mensagens em ${c.dias_ativos_baseline} dias distintos nos 30 anteriores. O inbound não está chegando ou está sendo barrado antes da fila (token do Spark Leads, canal desconectado, working_hours vazio, targeting, wallet).`;

      await recordSignal({
        type: "failure",
        title,
        description: descricao,
        // Agente ligado e mudo é pior: ninguém tem motivo pra desconfiar.
        severity: c.classe === "muda_com_agente_ligado" ? "high" : "medium",
        source: "bot_auto",
        metadata: { feature: "vigia-contas-mudas", ...c },
      });
      sinais++;
    }
  }

  return { ok: true, verificadas: porLocation.size, achados, sinais_emitidos: sinais };
}
