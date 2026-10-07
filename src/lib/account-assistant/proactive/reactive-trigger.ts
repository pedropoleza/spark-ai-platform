/**
 * Reactive trigger — F27.D (Pedro 2026-05-29; custom field 2026-07-06).
 *
 * Quando o GHL/Spark Leads notifica "tag adicionada", "lead entrou em estágio"
 * ou "custom field mudou", esse módulo:
 *  1. Lista agentes lead-facing ATIVOS da location.
 *  2. Filtra os que têm `targeting_rules` que bate com o evento.
 *  3. Pra cada match, enfileira UMA mensagem "trigger sintético" em
 *     `message_queue`. O queue-processor reconhece pelo prefix do body
 *     e gera 1ª mensagem proativa (sem esperar lead mandar nada).
 *
 * Idempotência: antes de disparar, consulta `execution_log` últimas 24h
 * com `action_type='reactive_trigger_fired'`. Se mesmo (agent, contact,
 * event_key) já fired = skip. Evita disparo em loop quando o evento
 * (tag/campo) é reenviado várias vezes.
 *
 * Custom field (Pedro 2026-07-06 — caso Alves Cury): o `CONTACTUPDATE` do GHL
 * chega com TODOS os customFields (valor ATUAL, sem diff antes/depois). Por isso
 * o disparo por custom field tem uma guarda EXTRA além do dedup de 24h: só
 * dispara se o contato ainda NÃO tem conversa com esse agente. Senão um
 * ContactUpdate solto de um contato já em atendimento re-abriria a conversa do
 * zero. O caso "lead falou antes da IA ligar" NÃO tem conversation_state (o
 * inbound foi descartado no targeting), então passa a guarda e o agente
 * "continua" via lead_history.
 *
 * Diferente do `reaction-engine.ts` (POST-LLM, reage a `on_data_field_set`),
 * esse é PRE-LLM: dispara o agente do zero quando webhook GHL chega.
 *
 * Gate: roda só quando `isProactiveEventsEnabled()` (env
 * `PROACTIVE_EVENTS_ENABLED`) e, se `PROACTIVE_EVENTS_LOCATIONS` estiver setado,
 * só pras locations da allowlist (escopo de rollout — ver event-router).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTargeting } from "@/lib/queue/targeting";
import { isWithinWorkingHours, nextWorkingHourStart } from "@/lib/queue/working-hours";
import { recordSignal } from "@/lib/admin-signals/recorder";
import type { TargetingRule, TargetingRules, WorkingHoursConfig } from "@/types/agent";

const REACTIVE_TRIGGER_PREFIX = "__reactive_trigger__:";

export type ReactiveTriggerKind =
  | "tag_added"
  | "tag_removed"
  | "stage_changed"
  | "contact_created"
  | "custom_field_changed";

export interface ReactiveTriggerContext {
  locationId: string;
  contactId: string;
  kind: ReactiveTriggerKind;
  /** Para tag_*: o nome da tag. Para stage_changed: o ID do estágio. Vazio p/ custom_field. */
  key: string;
  /** Para stage_changed: o pipeline ID (opcional). */
  pipelineId?: string;
  /** Para custom_field_changed: os customFields ATUAIS do contato {id, value}.
   *  Cada agente casa o SEU (custom_field_key + custom_field_value). */
  customFields?: Array<{ id: string; value: string }>;
  /** H102: `opportunity_create` = o lead NASCEU na etapa (OpportunityCreate),
   *  não foi movido pra ela. Mesmo `kind` (stage_changed) e mesma chave de dedup
   *  da movimentação, mas com as guardas de lead novo (disjuntor de rajada,
   *  nunca por cima de conversa, expediente do agente). */
  origem?: "opportunity_create";
}

interface AgentConfigRow {
  targeting_rules: TargetingRule[] | null;
  outreach_config: Record<string, unknown> | null;
  entry_by_automation?: boolean | null;
  working_hours?: WorkingHoursConfig | null;
}

interface AgentRow {
  id: string;
  type: string;
  audience: string | null;
  agent_configs: AgentConfigRow | AgentConfigRow[] | null;
}

function extractConfig(agent: AgentRow) {
  const cfg = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
  // v2 (Pedro 2026-06-17): targeting_rules pode ser array legado OU set v2 com
  // grupos E/OU. Achata pra folhas — matchedTriggerKey casa tag/pipeline_stage/
  // custom_field (ignora message, que não tem trigger reativo por evento).
  const set = normalizeTargeting((cfg?.targeting_rules ?? null) as TargetingRules | null);
  const rules: TargetingRule[] = set ? set.groups.flatMap((g) => g.rules) : [];
  return {
    rules,
    outreachOn: !!(cfg?.outreach_config as { enabled?: boolean } | null)?.enabled,
  };
}

/**
 * Devolve a CHAVE de dedup do evento se ALGUMA regra do agente casa, senão null.
 * A chave é específica da regra que disparou (tag / estágio / campo:valor), pra
 * o dedup de 24h não confundir gatilhos diferentes do mesmo contato.
 *
 *  - tag_added "VIP" + rule {type:"tag", tag:"VIP"} -> "tag_added:VIP"
 *  - stage_changed "stageX" + rule {type:"pipeline_stage", pipeline_stage_id:"stageX"} -> "stage_changed:stageX"
 *  - custom_field_changed + rule {type:"custom_field", key:AI, value:"Venda"} e o
 *    contato tem esse campo com esse valor -> "custom_field_changed:AI:Venda"
 *    (valor vazio na regra = "qualquer valor")
 *  - rules vazias / nenhum match -> null
 */
export function matchedTriggerKey(rules: TargetingRule[], ev: ReactiveTriggerContext): string | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    // H81 (2026-08-26): folha de EXCLUSÃO NUNCA é gatilho. O achatamento acima
    // junta as folhas de TODOS os grupos, então as negadas (ex: `client`,
    // `ia-desligada`) chegavam aqui iguais às de entrada — e este matcher só
    // olhava type+tag. Resultado: marcar um contato como `client` DISPARARIA a
    // conversa proativa do agente de recrutamento com um cliente, que é o
    // oposto exato do que a exclusão existe pra fazer (é o incidente da Jussara
    // chegando pela porta dos fundos). Negar é o contrário de ativar: pula.
    if (rule.negate) continue;
    if (ev.kind === "tag_added" && rule.type === "tag" && rule.tag && ev.key === rule.tag) {
      return `tag_added:${rule.tag}`;
    }
    if (
      ev.kind === "stage_changed" &&
      rule.type === "pipeline_stage" &&
      rule.pipeline_stage_id &&
      ev.key === rule.pipeline_stage_id &&
      (!rule.pipeline_id || !ev.pipelineId || rule.pipeline_id === ev.pipelineId)
    ) {
      return `stage_changed:${rule.pipeline_stage_id}`;
    }
    if (ev.kind === "custom_field_changed" && rule.type === "custom_field" && rule.custom_field_key) {
      const hit = (ev.customFields || []).find((f) => f.id === rule.custom_field_key);
      if (hit) {
        const wanted = (rule.custom_field_value ?? "").trim();
        if (!wanted || wanted === (hit.value ?? "").trim()) {
          return `custom_field_changed:${rule.custom_field_key}:${hit.value}`;
        }
      }
    }
  }
  return null;
}

/** Back-compat: booleano de match (delega pra matchedTriggerKey). */
export function ruleMatchesTrigger(rules: TargetingRule[], ev: ReactiveTriggerContext): boolean {
  return matchedTriggerKey(rules, ev) !== null;
}

function eventKey(ev: ReactiveTriggerContext): string {
  return `${ev.kind}:${ev.key}${ev.pipelineId ? `:${ev.pipelineId}` : ""}`;
}

/**
 * Encode do trigger no body da queue. queue-processor detecta o prefix e
 * gera 1ª msg proativa. Pra custom_field o body é GENÉRICO (a abertura NÃO cita
 * o campo/valor); o valor específico fica só no dedup key, não no body.
 */
export function encodeTriggerBody(ev: ReactiveTriggerContext): string {
  if (ev.kind === "custom_field_changed") return `${REACTIVE_TRIGGER_PREFIX}custom_field_changed:activated`;
  // H102: 4º segmento marca lead novo. O pipeline vai sempre (mesmo vazio) pra
  // origem cair na posição fixa que o parseTriggerBody lê.
  if (ev.origem === "opportunity_create") {
    return `${REACTIVE_TRIGGER_PREFIX}${ev.kind}:${ev.key}:${ev.pipelineId ?? ""}:create`;
  }
  return `${REACTIVE_TRIGGER_PREFIX}${eventKey(ev)}`;
}

export function isReactiveTriggerBody(body: string | null | undefined): boolean {
  return !!body && body.startsWith(REACTIVE_TRIGGER_PREFIX);
}

export function parseTriggerBody(
  body: string,
): { kind: ReactiveTriggerKind; key: string; pipelineId?: string; origem?: "opportunity_create" } | null {
  if (!isReactiveTriggerBody(body)) return null;
  const payload = body.slice(REACTIVE_TRIGGER_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length < 2) return null;
  const kind = parts[0] as ReactiveTriggerKind;
  const key = parts[1];
  const pipelineId = parts[2] || undefined;
  return parts[3] === "create" ? { kind, key, pipelineId, origem: "opportunity_create" } : { kind, key, pipelineId };
}

/**
 * Idempotência: checa se mesmo (agent, contact, dedupKey) já foi disparado
 * nas últimas 24h. Usa execution_log como audit + cache.
 */
async function alreadyFired(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  contactId: string,
  dedupKey: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("execution_log")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("action_type", "reactive_trigger_fired")
    .gte("created_at", cutoff)
    .contains("action_payload", { event_key: dedupKey });
  return (count ?? 0) > 0;
}

/**
 * Guarda anti-reabertura (só custom_field): não dispara proativo se o contato
 * JÁ tem conversa com esse agente. Ver bloco de doc no topo.
 */
async function hasConversation(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  contactId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("conversation_state")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId);
  return (count ?? 0) > 0;
}

async function logSkip(
  supabase: ReturnType<typeof createAdminClient>,
  agentId: string,
  ev: ReactiveTriggerContext,
  eventKey: string,
  reason: string,
): Promise<void> {
  await supabase.from("execution_log").insert({
    agent_id: agentId,
    location_id: ev.locationId,
    contact_id: ev.contactId,
    conversation_id: "",
    action_type: "reactive_trigger_skipped",
    action_payload: { reason, event_key: eventKey, kind: ev.kind },
    success: true,
  });
}

/**
 * H101 (bug observado em prod 2026-10-07 18:07 UTC, Alves Cury, contato de teste
 * 1ajBkGersnYd9OWn9Ebh): a Bruna estava respondendo um "Olá" do lead e, 23s
 * depois, o gatilho reativo de campo abriu o Bruno no MESMO contato — dois
 * agentes respondendo com 21s de diferença. A guarda anti-reabertura só
 * perguntava pelo PRÓPRIO agente. Esta pergunta por QUALQUER OUTRO agente.
 *
 * Duas fontes, porque existe uma janela entre elas:
 *  - conversation_state: o outro agente já tem conversa (ativa, pausada ou
 *    entregue a humano — em qualquer caso o contato tem dono);
 *  - message_queue pendente: o inbound do lead já foi entregue a outro agente e
 *    está no debounce (~15s), ANTES de virar linha de conversa. É exatamente a
 *    janela em que o caso de hoje cairia se o evento chegasse uns segundos antes.
 */
export async function outroAgenteNaConversa(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  agentId: string,
  contactId: string,
): Promise<string | null> {
  const { data: st } = await supabase
    .from("conversation_state")
    .select("agent_id")
    .eq("location_id", locationId)
    .eq("contact_id", contactId)
    .neq("agent_id", agentId)
    .limit(1);
  if (st && st.length > 0) return "conversation_state";
  const { data: fila } = await supabase
    .from("message_queue")
    .select("agent_id")
    .eq("location_id", locationId)
    .eq("contact_id", contactId)
    .neq("agent_id", agentId)
    .in("status", ["pending", "processing"])
    .limit(1);
  if (fila && fila.length > 0) return "message_queue_pendente";
  return null;
}

/**
 * H102 (2026-10-07, caso Vergus/Cleybart): disjuntor de importação em massa do
 * gatilho de lead novo.
 *
 * Lead de formulário nasce direto na etapa (OpportunityCreate) e é exatamente o
 * que o cliente quer que a IA aborde. Só que importar uma planilha também cria
 * oportunidade na etapa, uma por linha, e sem trava cada linha viraria uma
 * mensagem da IA: disparo em massa pra uma base que ninguém pediu pra abordar,
 * pelo número do cliente. Um evento não diz se veio de formulário ou de
 * importação (`source` vem vazio na maioria), mas o ritmo diz: a Vergus recebe
 * ~4 leads novos por DIA (medido em 07/10); importação chega às dezenas por
 * minuto.
 *
 * Então: no máximo `maxPorJanela` aberturas por location a cada `janelaMin`.
 * Estourou → o disjuntor arma e a location para de abordar lead novo por
 * `pausaHoras` (janela fixa sozinha vazaria 5 a cada 10 min de uma importação
 * longa). O lead não fica sem atendimento: se escrever, o inbound segue normal.
 *
 * As vagas são linhas em `sparkbot_dedup_locks` (PK) e não uma contagem: contar
 * antes de inserir deixaria 50 lambdas simultâneas de uma importação passarem
 * juntas, todas vendo "0 até agora". Falha de banco = NÃO aborda (fail-closed):
 * não abordar é o comportamento de antes do H102, disparar em massa não é.
 */
export const RAJADA_LEAD_NOVO = { janelaMin: 10, maxPorJanela: 5, pausaHoras: 6 } as const;

export type VagaLeadNovo = "ok" | "disjuntor_aberto" | "disjuntor_armado_agora" | "erro";

export function chaveDisjuntorLeadNovo(locationId: string): string {
  return `rajada-lead-novo:${locationId}`;
}

export async function reservarVagaDeLeadNovo(
  supabase: ReturnType<typeof createAdminClient>,
  locationId: string,
  agora: number = Date.now(),
): Promise<VagaLeadNovo> {
  const chaveDisjuntor = chaveDisjuntorLeadNovo(locationId);
  const { data: aberto, error: errLeitura } = await supabase
    .from("sparkbot_dedup_locks")
    .select("dedup_key")
    .eq("dedup_key", chaveDisjuntor)
    .gt("expires_at", new Date(agora).toISOString())
    .maybeSingle();
  if (errLeitura) return "erro";
  if (aberto) return "disjuntor_aberto";

  const janela = Math.floor(agora / (RAJADA_LEAD_NOVO.janelaMin * 60_000));
  const expira = new Date(agora + 24 * 60 * 60 * 1000).toISOString();
  for (let vaga = 1; vaga <= RAJADA_LEAD_NOVO.maxPorJanela; vaga++) {
    const { error } = await supabase.from("sparkbot_dedup_locks").insert({
      dedup_key: `lead-novo:${locationId}:${janela}:${vaga}`,
      content_preview: "opportunity_create",
      expires_at: expira,
    });
    if (!error) return "ok";
    if (error.code !== "23505") return "erro";
  }

  // Upsert, não insert: a linha de um disjuntor vencido pode ainda não ter sido
  // varrida pelo cleanup (roda a cada 5 min) e o insert bateria na PK.
  const { error: errArma } = await supabase.from("sparkbot_dedup_locks").upsert(
    {
      dedup_key: chaveDisjuntor,
      content_preview: "disjuntor_lead_novo",
      expires_at: new Date(agora + RAJADA_LEAD_NOVO.pausaHoras * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "dedup_key" },
  );
  return errArma ? "erro" : "disjuntor_armado_agora";
}

/**
 * Dispara o(s) agente(s) que devem reagir a esse evento.
 * Retorna count de triggers enfileirados.
 */
export async function triggerReactiveAgents(ev: ReactiveTriggerContext): Promise<{ fired: number; matched: number }> {
  if (!ev.contactId || !ev.locationId) return { fired: 0, matched: 0 };
  // custom_field precisa dos campos; os demais precisam de key.
  if (ev.kind === "custom_field_changed") {
    if (!ev.customFields || ev.customFields.length === 0) return { fired: 0, matched: 0 };
  } else if (!ev.key) {
    return { fired: 0, matched: 0 };
  }
  const supabase = createAdminClient();

  // Lista agentes lead-facing ATIVOS da location (rep-facing/SparkBot ignorado —
  // não tem targeting nem opera por evento de tag/campo de lead).
  const { data: agents } = await supabase
    .from("agents")
    .select("id, type, audience, agent_configs(targeting_rules, outreach_config, entry_by_automation, working_hours)")
    .eq("location_id", ev.locationId)
    .eq("status", "active")
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"])
    // H101: ordem estável — sem ela, quando dois agentes casam o mesmo evento,
    // quem dispara é sorteio (mesma lição do MC-10 no webhook).
    .order("created_at", { ascending: true });

  if (!agents || agents.length === 0) return { fired: 0, matched: 0 };

  let matched = 0;
  let fired = 0;

  for (const a of agents as AgentRow[]) {
    if (a.audience && a.audience !== "lead") continue;
    const { rules, outreachOn } = extractConfig(a);
    // Outreach (bulk) tem seu próprio fluxo via bulk-runner — não dispara aqui.
    if (outreachOn) continue;
    const dedupKey = matchedTriggerKey(rules, ev);
    if (!dedupKey) continue;
    matched++;

    // H90 (fix bug observado em prod 2026-09-04 01:15, 1º lead da entrada pela
    // automação na conta da Márcia): com `entry_by_automation`, quem ABRE a
    // conversa é o workflow do Spark Leads, e a tag que ele adiciona serve pra
    // LIGAR o targeting, não pra disparar abridor. Sem esta guarda, a tag
    // disparou este gatilho, a IA se apresentou e pediu os dados em paralelo
    // com a saudação do workflow, e o turno do clique (que chegou depois)
    // achou a conversa ativa e respondeu de novo: 9 mensagens pro lead.
    const cfgRow = Array.isArray(a.agent_configs) ? a.agent_configs[0] : a.agent_configs;
    {
      if (cfgRow?.entry_by_automation === true) {
        await supabase.from("execution_log").insert({
          agent_id: a.id,
          location_id: ev.locationId,
          contact_id: ev.contactId,
          conversation_id: "",
          action_type: "reactive_trigger_skipped",
          action_payload: { reason: "entry_by_automation", event_key: dedupKey, kind: ev.kind },
          success: true,
        });
        continue;
      }
    }

    // H101: um evento abre NO MÁXIMO um agente por contato. Sem isto, um
    // ContactUpdate que casa dois agentes abriria os dois na mesma chamada — a
    // linha de conversa do primeiro só nasce no processor, então a guarda abaixo
    // ainda não a veria.
    if (fired > 0) {
      await logSkip(supabase, a.id, ev, dedupKey, "outro_agente_ja_disparou_neste_evento");
      continue;
    }
    // H101: outro agente já está nesta conversa → não abre um segundo. Vale pra
    // TODO tipo de evento (a guarda do próprio agente, logo abaixo, segue só
    // pros eventos do ContactUpdate, como antes).
    {
      const onde = await outroAgenteNaConversa(supabase, ev.locationId, a.id, ev.contactId);
      if (onde) {
        await logSkip(supabase, a.id, ev, dedupKey, `outro_agente_na_conversa:${onde}`);
        continue;
      }
    }

    // Guarda anti-reabertura: não re-abre contato que já tem conversa com ESTE
    // agente. Vale pros dois eventos que vêm do CONTACTUPDATE — que manda o
    // contato INTEIRO, sem diff antes/depois. H82 (2026-08-26) estendeu pra
    // `tag_added`: como a tag agora é lida do ContactUpdate (o
    // ContactTagUpdate não é entregue — medido ao vivo em 26/08), qualquer
    // atualização do contato reapresenta as mesmas tags, e sem esta guarda um
    // ContactUpdate solto reabriria do zero a conversa de quem já está sendo
    // atendido.
    if (
      (ev.kind === "custom_field_changed" || ev.kind === "tag_added") &&
      (await hasConversation(supabase, a.id, ev.contactId))
    ) {
      continue;
    }
    // H102: lead novo nunca abre por cima de conversa que já existe com este
    // agente. Criar oportunidade pra quem já está conversando (o lead do
    // Instagram que depois preencheu o formulário) não é motivo pra IA se
    // apresentar de novo no meio do papo. A movimentação de etapa segue como
    // era: ali mover o card É o pedido pra IA retomar.
    if (ev.origem === "opportunity_create" && (await hasConversation(supabase, a.id, ev.contactId))) {
      await logSkip(supabase, a.id, ev, dedupKey, "lead_novo_ja_tem_conversa");
      continue;
    }

    if (await alreadyFired(supabase, a.id, ev.contactId, dedupKey)) continue;

    // C9 (caso Alves Cury 2026-08-31, contato YGHp2pYs): dois ContactUpdate
    // simultâneos passavam ambos no alreadyFired (check-then-insert) → 2 rows
    // no MESMO segundo. Claim atômico via PK de sparkbot_dedup_locks: quem
    // perde o INSERT (23505) desiste. TTL 24h = janela do dedup de evento.
    {
      const { error: lockErr } = await supabase.from("sparkbot_dedup_locks").insert({
        dedup_key: `reactive:${a.id}:${ev.contactId}:${dedupKey}`.slice(0, 250),
        content_preview: ev.kind,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      if (lockErr) {
        if (lockErr.code === "23505") continue; // corrida — o gêmeo já enfileirou
        // Falha de infra no lock não pode calar o trigger: segue (o dedup de
        // 24h via execution_log continua valendo como 2ª camada).
        console.warn(`[reactive-trigger] lock falhou (segue sem claim): ${lockErr.message}`);
      }
    }

    // H102: disjuntor de importação em massa. Depois do lock C9 de propósito:
    // o webhook gêmeo do MESMO evento morre no lock e não gasta vaga.
    if (ev.origem === "opportunity_create") {
      const vaga = await reservarVagaDeLeadNovo(supabase, ev.locationId);
      if (vaga !== "ok") {
        await logSkip(supabase, a.id, ev, dedupKey, `lead_novo_${vaga}`);
        if (vaga === "disjuntor_armado_agora") {
          await recordSignal({
            type: "failure",
            severity: "high",
            source: "system",
            title: `Lead novo: abordagem da IA pausada por rajada (possível importação) na location ${ev.locationId}`,
            description:
              `Mais de ${RAJADA_LEAD_NOVO.maxPorJanela} leads novos casaram o gatilho de funil em ` +
              `${RAJADA_LEAD_NOVO.janelaMin} min. A IA parou de abordar leads novos desta conta por ` +
              `${RAJADA_LEAD_NOVO.pausaHoras}h pra não disparar em massa numa lista importada. Quem ` +
              `escrever continua sendo atendido. Se era tráfego real, libera apagando a linha ` +
              `'${chaveDisjuntorLeadNovo(ev.locationId)}' de sparkbot_dedup_locks.`,
            metadata: { location_id: ev.locationId, agent_id: a.id, contact_id: ev.contactId, stage_id: ev.key },
          }).catch(() => {});
        }
        continue;
      }
    }

    // C6 (caso Alves Cury 2026-08-31): o turno proativo sai pelo canal em que o
    // LEAD fala (último inbound dele), não pelo default SMS da coluna — na conta
    // do Marcos o canal SMS passa pelo provider custom dele e duplica a timeline.
    let leadChannel: string | null = null;
    try {
      const { data: lastIn } = await supabase
        .from("message_queue")
        .select("channel")
        .eq("location_id", ev.locationId)
        .eq("contact_id", ev.contactId)
        .eq("message_direction", "inbound")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadChannel = (lastIn?.channel as string | null) || null;
    } catch {
      /* canal é best-effort — default SMS da coluna cobre */
    }

    // Enfileira o trigger sintético. queue-processor detecta o prefix.
    const nowIso = new Date().toISOString();
    // H102: lead novo respeita o expediente do agente, igual ao inbound do
    // webhook. Sem isso, o lead do formulário das 23h recebia a abertura na hora
    // e, ao responder, esperava até a manhã seguinte pela 2ª mensagem. Schedule
    // impossível (null) = fail-open, como no webhook (H52). Os gatilhos que já
    // existiam (tag, campo, movimentação) seguem imediatos, como sempre foram.
    let processAfter = nowIso;
    if (ev.origem === "opportunity_create") {
      const wh = cfgRow?.working_hours;
      if (wh?.enabled && !isWithinWorkingHours(wh)) {
        processAfter = nextWorkingHourStart(wh) ?? nowIso;
      }
    }
    const { error: queueErr } = await supabase.from("message_queue").insert({
      agent_id: a.id,
      location_id: ev.locationId,
      contact_id: ev.contactId,
      // Sem conversation_id real — bot vai criar/buscar via GHL.
      conversation_id: "",
      message_body: encodeTriggerBody(ev),
      message_type: "REACTIVE_TRIGGER",
      message_direction: "system",
      ghl_message_id: null,
      received_at: nowIso,
      process_after: processAfter,
      status: "pending",
      ...(leadChannel ? { channel: leadChannel } : {}),
    });

    if (queueErr) {
      console.warn(`[reactive-trigger] enfileirar falhou agent=${a.id}: ${queueErr.message}`);
      continue;
    }

    // Audit + idempotência.
    await supabase.from("execution_log").insert({
      agent_id: a.id,
      location_id: ev.locationId,
      contact_id: ev.contactId,
      action_type: "reactive_trigger_fired",
      action_payload: {
        event_key: dedupKey,
        kind: ev.kind,
        key: ev.key,
        pipeline_id: ev.pipelineId || null,
        ...(ev.origem ? { origem: ev.origem } : {}),
        ...(processAfter !== nowIso ? { adiado_para: processAfter } : {}),
      },
      success: true,
    });

    fired++;
  }

  if (matched > 0) {
    console.log(`[reactive-trigger] ${ev.kind} loc=${ev.locationId} matched=${matched} fired=${fired}`);
  }

  return { fired, matched };
}
