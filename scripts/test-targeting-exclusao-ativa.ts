/**
 * H97: a EXCLUSÃO do público (folha `negate`, H81) vale em conversa ativa e no
 * follow-up, mesmo quando o targeting é pulado.
 *
 * Motivo (bug observado em prod 2026-09-28, conta da Jussara, agente a297dadc):
 * em `trigger_once` com conversa ativa o queue-processor pulava o targeting
 * INTEIRO, e o runner de follow-up nunca olhou targeting. "Não atender quem tem
 * a tag active client" só barrava a 1ª mensagem; a IA respondeu clientes com
 * apólice e prometeu coisas a eles.
 *
 * Quatro partes:
 *   A) avaliador puro com os payloads REAIS da frota (Jussara + Bianca, lidos
 *      do banco em 28/09) + a propriedade "nunca barra quem o gate deixaria
 *      passar" (sem ela a exclusão recriaria o "responde a 1ª e morre");
 *   B) `checkContactExclusion`: zero I/O sem exclusão, reaproveita contato,
 *      e FAIL-OPEN quando a leitura falha;
 *   C) ponta a ponta no `processMessageQueue` (Supabase falso via fetch global,
 *      GHLClient.get substituído): trigger_once + conversa ativa;
 *   D) ponta a ponta no `processScheduledFollowUps`: toque de contato excluído
 *      é cancelado (sequência inteira) e auditado.
 *
 * Não toca rede nem banco: qualquer fetch fora do Supabase falso lança.
 *
 *   npx tsx scripts/test-targeting-exclusao-ativa.ts
 */
import type { TargetingRuleSet } from "@/types/agent";

// Env falso ANTES de qualquer import do app (os módulos são carregados com
// import dinâmico dentro do main, depois disto).
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: "http://sb.fake",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake",
  SUPABASE_SERVICE_ROLE_KEY: "fake",
  JWT_SECRET: "fake",
  OPENAI_API_KEY: "fake",
  GHL_TOKEN_SUPABASE_URL: "http://sb.fake",
  GHL_TOKEN_SUPABASE_SERVICE_KEY: "fake",
  NEXT_PUBLIC_GHL_COMPANY_ID: "fake",
  CRON_SECRET: "fake",
});

let ok = 0;
let fail = 0;
function t(nome: string, cond: boolean, detalhe = "") {
  if (cond) {
    ok++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome}${detalhe ? `  → ${detalhe}` : ""}`);
  }
}
const h = (s: string) => console.log(`\n${s}`);

/* ── payloads reais (agent_configs.targeting_rules, lidos em 28/09) ─────── */

const JUSSARA: TargetingRuleSet = {
  match: "all",
  groups: [
    {
      id: "g-lead-anuncio",
      match: "any",
      rules: [
        { id: "tg-ctwa", tag: "ctwa-lead", type: "tag" },
        { id: "tg-anuncio", tag: "anuncio", type: "tag" },
        { id: "tg-anuncio-ig", tag: "anuncio-instagram", type: "tag" },
        { id: "tg-metaads", tag: "metaads", type: "tag" },
        { id: "tg-patroc", tag: "patrocinados", type: "tag" },
        { id: "tg-aiq", tag: "ai qualification active", type: "tag" },
        { id: "fr-1", type: "message", message_value: "Tenho interesse e queria mais informações", message_operator: "contains" },
        { id: "fr-2", type: "message", message_value: "Olá gostaria de saber mais sobre o seguro em vida", message_operator: "contains" },
      ],
    },
    {
      id: "g-nao-cliente",
      match: "all",
      rules: [
        { id: "ex-active-client", tag: "active client", type: "tag", negate: true },
        { id: "ex-client", tag: "client", type: "tag", negate: true },
        { id: "ex-cliente", tag: "cliente", type: "tag", negate: true },
        { id: "ex-hash-cliente", tag: "#cliente", type: "tag", negate: true },
        { id: "ex-apolice-ativa", tag: "apólice ativa", type: "tag", negate: true },
      ],
    },
  ],
  version: 2,
};

const EXCLUSAO_BIANCA = [
  { id: "exc-0", tag: "client", type: "tag" as const, negate: true },
  { id: "exc-1", tag: "cliente", type: "tag" as const, negate: true },
  { id: "exc-2", tag: "contato pessoal", type: "tag" as const, negate: true },
  { id: "exc-3", tag: "pessoal bia", type: "tag" as const, negate: true },
  { id: "exc-4", tag: "membro da agencia", type: "tag" as const, negate: true },
  { id: "exc-5", tag: "ia-desligada", type: "tag" as const, negate: true },
];

const BIANCA_SEGUIDORES: TargetingRuleSet = {
  match: "all",
  groups: [
    {
      id: "g-entrada",
      match: "any",
      rules: [
        { id: "ent-tag-seguidor", tag: "novo seguidor", type: "tag" },
        { id: "ent-tag-sdr", tag: "ia-ligada", type: "tag" },
        { id: "ent-tag-atendido", tag: "origem-seguidor-ia", type: "tag" },
      ],
    },
    {
      id: "g-organico",
      match: "all",
      rules: [
        { id: "org-nao-pago", type: "attribution", attribution_field: "sessionSource", attribution_scope: "first", attribution_value: "Paid", attribution_operator: "not_contains" },
      ],
    },
    { id: "g-exclusao", match: "all", rules: EXCLUSAO_BIANCA },
  ],
  version: 2,
};

const BIANCA_TRAFEGO: TargetingRuleSet = {
  match: "all",
  groups: [
    {
      id: "g-entrada",
      match: "any",
      rules: [
        { id: "ent-attr-paid", type: "attribution", attribution_field: "sessionSource", attribution_scope: "first", attribution_value: "Paid", attribution_operator: "contains" },
        { id: "ent-msg-anuncio", type: "message", message_value: "Quero me tornar um Agente Financeiro", message_operator: "contains" },
        { id: "ent-tag-atendido", tag: "origem-anuncio-ia", type: "tag" },
      ],
    },
    { id: "g-exclusao", match: "all", rules: EXCLUSAO_BIANCA },
  ],
  version: 2,
};

const contato = (tags: string[], extra: Record<string, unknown> = {}) => ({ tags, ...extra });

async function main() {
  const {
    avaliarExclusao,
    evaluateTargetingSet,
    checkContactExclusion,
    folhasDeExclusao,
    descreveFolha,
  } = await import("@/lib/queue/targeting");
  const { GHLClient } = await import("@/lib/ghl/client");

  /* ═══ A. avaliador puro ═══════════════════════════════════════════════ */
  h("A1. Jussara (payload real): quem virou cliente é barrado em conversa ativa");
  for (const [tag, rot] of [
    ["active client", "active client"],
    ["client", "client"],
    ["cliente", "cliente"],
    ["#cliente", "#cliente"],
    ["apólice ativa", "apólice ativa"],
    ["Apolice Ativa", "apólice ativa (sem acento, caixa alta: deburr do H70)"],
    ["ACTIVE CLIENT", "ACTIVE CLIENT (caixa)"],
  ] as const) {
    const r = avaliarExclusao(JUSSARA, contato(["ctwa-lead", tag]) as never, []);
    t(`tag ${rot} → barrado`, r.excluded === true, JSON.stringify(r));
  }
  const motivo = avaliarExclusao(JUSSARA, contato(["active client", "cliente"]) as never, []);
  t("motivo lista as tags que casaram (vai pro execution_log)",
    JSON.stringify(motivo.motivos) === JSON.stringify(['tag "active client"', 'tag "cliente"']),
    JSON.stringify(motivo.motivos));

  h("A2. Jussara: sem etiqueta de cliente, a conversa ativa segue");
  t("lead de anúncio (ctwa-lead) → não barrado", !avaliarExclusao(JUSSARA, contato(["ctwa-lead"]) as never, []).excluded);
  t("lead que entrou por FRASE, sem tag nenhuma → não barrado (inclusão continua pulada)",
    !avaliarExclusao(JUSSARA, contato([]) as never, []).excluded);
  t("…e é exatamente o contato que o gate completo barraria no 2º turno (por isso o trigger_once pula a inclusão)",
    evaluateTargetingSet(JUSSARA, contato([]) as never, [], { messageText: "2", conversationActive: true }) === false);
  t("tag parecida mas diferente ('ex-cliente') → não barrado (casamento exato, não substring)",
    !avaliarExclusao(JUSSARA, contato(["ex-cliente"]) as never, []).excluded);
  t("contato sem objeto (null) → não barrado", !avaliarExclusao(JUSSARA, null, []).excluded);

  h("A3. Bianca (2 agentes, payload real)");
  t("seguidores: 'ia-desligada' → barrado", avaliarExclusao(BIANCA_SEGUIDORES, contato(["novo seguidor", "ia-desligada"]) as never, []).excluded);
  t("seguidores: 'membro da agência' com acento → barrado", avaliarExclusao(BIANCA_SEGUIDORES, contato(["Membro da Agência"]) as never, []).excluded);
  t("seguidores: seguidor comum → não barrado", !avaliarExclusao(BIANCA_SEGUIDORES, contato(["novo seguidor"]) as never, []).excluded);
  t("seguidores: folha de origem (inclusão) NÃO é reavaliada: veio de anúncio e segue",
    !avaliarExclusao(BIANCA_SEGUIDORES, contato(["novo seguidor"], { attributionSource: { sessionSource: "Paid Social" } }) as never, []).excluded);
  t("tráfego: cliente vindo de anúncio → barrado",
    avaliarExclusao(BIANCA_TRAFEGO, contato(["client"], { attributionSource: { sessionSource: "Paid Social" } }) as never, []).excluded);
  t("tráfego: lead de anúncio → não barrado",
    !avaliarExclusao(BIANCA_TRAFEGO, contato([], { attributionSource: { sessionSource: "Paid Social" } }) as never, []).excluded);

  h("A4. Neutro nunca vira catch-all (propriedade do H81)");
  const soNeutra: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [{ id: "vazia", type: "tag", tag: "", negate: true }] }],
  };
  t("exclusão de tag VAZIA não barra ninguém", !avaliarExclusao(soNeutra, contato(["qualquer"]) as never, []).excluded);
  t("…nem contato sem tags", !avaliarExclusao(soNeutra, contato([]) as never, []).excluded);
  const vaziaMaisReal: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [
      { id: "vazia", type: "tag", tag: "", negate: true },
      { id: "real", type: "tag", tag: "cliente", negate: true },
    ] }],
  };
  t("folha vazia ao lado de uma real: só a real decide (cliente barrado)", avaliarExclusao(vaziaMaisReal, contato(["cliente"]) as never, []).excluded);
  t("folha vazia ao lado de uma real: lead passa", !avaliarExclusao(vaziaMaisReal, contato(["lead"]) as never, []).excluded);
  const msgNegada: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [{ id: "m", type: "message", message_operator: "contains", message_value: "vaga", negate: true }] }],
  };
  t("exclusão por MENSAGEM é neutra aqui (conteúdo é gatilho de entrada)", !avaliarExclusao(msgNegada, contato([]) as never, []).excluded);
  const semNegate: TargetingRuleSet = {
    version: 2, match: "all", groups: [{ id: "g", match: "all", rules: [{ id: "a", type: "tag", tag: "cliente" }] }],
  };
  t("set sem nenhuma exclusão → nunca barra (mesmo sem a tag de inclusão)", !avaliarExclusao(semNegate, contato([]) as never, []).excluded);
  t("folhasDeExclusao acha as 5 da Jussara", folhasDeExclusao(JUSSARA).length === 5);

  h("A5. Nunca barra quem o gate completo deixaria passar com as mesmas tags");
  // Exclusão dentro de grupo OU: na entrada, "anuncio OU NÃO cliente" deixa
  // passar o cliente que tem anuncio. Barrá-lo no 2º turno seria o "responde a
  // 1ª e morre" (H51/H96) de volta. A projeção mantém a mesma leitura da árvore.
  const exclusaoEmOu: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "any", rules: [
      { id: "a", type: "tag", tag: "anuncio" },
      { id: "x", type: "tag", tag: "cliente", negate: true },
    ] }],
  };
  t("exclusão em grupo OU com inclusão: segue a árvore (não barra)",
    !avaliarExclusao(exclusaoEmOu, contato(["anuncio", "cliente"]) as never, []).excluded);
  const setOu: TargetingRuleSet = {
    version: 2, match: "any",
    groups: [
      { id: "g1", match: "all", rules: [{ id: "a", type: "tag", tag: "anuncio" }] },
      { id: "g2", match: "all", rules: [{ id: "x", type: "tag", tag: "cliente", negate: true }] },
    ],
  };
  t("set OU: exclusão num ramo não barra quem entra pelo outro ramo (igual à entrada)",
    !avaliarExclusao(setOu, contato(["anuncio", "cliente"]) as never, []).excluded);
  const exclusaoEmMesmoGrupoE: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [
      { id: "a", type: "tag", tag: "anuncio" },
      { id: "x", type: "tag", tag: "cliente", negate: true },
    ] }],
  };
  t("exclusão no MESMO grupo E da inclusão → barra", avaliarExclusao(exclusaoEmMesmoGrupoE, contato(["cliente"]) as never, []).excluded);

  // Propriedade exaustiva: para todo subconjunto das tags relevantes e toda
  // mensagem de teste, se o gate completo DEIXA PASSAR, a exclusão NÃO barra.
  const universo = ["ctwa-lead", "anuncio", "active client", "cliente", "apólice ativa", "novo seguidor", "ia-desligada", "client"];
  const mensagens = ["Tenho interesse e queria mais informações", "2", "oi"];
  const sets: Array<[string, TargetingRuleSet]> = [
    ["jussara", JUSSARA], ["bianca-seguidores", BIANCA_SEGUIDORES], ["bianca-trafego", BIANCA_TRAFEGO],
    ["exclusao-em-ou", exclusaoEmOu], ["set-ou", setOu], ["mesmo-grupo-e", exclusaoEmMesmoGrupoE],
  ];
  let violacoes = 0;
  let casos = 0;
  for (const [nome, set] of sets) {
    for (let mask = 0; mask < 1 << universo.length; mask++) {
      const tags = universo.filter((_, i) => mask & (1 << i));
      for (const attr of [undefined, { sessionSource: "Paid Social" }]) {
        const c = contato(tags, attr ? { attributionSource: attr } : {});
        for (const msg of mensagens) {
          casos++;
          const gatePassa = evaluateTargetingSet(set, c as never, [], { messageText: msg });
          const barrado = avaliarExclusao(set, c as never, []).excluded;
          if (gatePassa && barrado) {
            violacoes++;
            if (violacoes <= 3) console.log(`     violação: ${nome} tags=${JSON.stringify(tags)} msg=${msg}`);
          }
        }
      }
    }
  }
  t(`nenhum contato admitido pelo gate é barrado pela exclusão (${casos} combinações)`, violacoes === 0, `${violacoes} violações`);

  h("A6. Outros tipos de folha como exclusão");
  const cf: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [{ id: "c", type: "custom_field", custom_field_key: "status_cliente", custom_field_value: "Ativo", negate: true }] }],
  };
  t("campo status_cliente = Ativo → barrado",
    avaliarExclusao(cf, contato([], { customFields: [{ id: "status_cliente", value: "ativo" }] }) as never, []).excluded);
  t("campo com outro valor → não barrado",
    !avaliarExclusao(cf, contato([], { customFields: [{ id: "status_cliente", value: "Prospect" }] }) as never, []).excluded);
  const etapa: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [{ id: "p", type: "pipeline_stage", pipeline_stage_id: "st-ganho", negate: true }] }],
  };
  t("opp na etapa excluída → barrado", avaliarExclusao(etapa, contato([]) as never, [{ pipelineStageId: "st-ganho" }]).excluded);
  t("opp em outra etapa → não barrado", !avaliarExclusao(etapa, contato([]) as never, [{ pipelineStageId: "st-novo" }]).excluded);
  t("descreveFolha(tag)", descreveFolha({ id: "x", type: "tag", tag: "active client", negate: true }) === 'tag "active client"');

  /* ═══ B. checkContactExclusion (I/O) ══════════════════════════════════ */
  const ghlChamadas: string[] = [];
  let ghlGet: (path: string) => Promise<unknown> = async () => {
    throw new Error("GHL não configurado neste cenário");
  };
  (GHLClient.prototype as unknown as { get: (p: string) => Promise<unknown> }).get = async function (path: string) {
    ghlChamadas.push(path);
    return ghlGet(path);
  };
  const zerar = () => { ghlChamadas.length = 0; };

  h("B1. Custo: agente sem exclusão não faz I/O nenhum");
  zerar();
  let r = await checkContactExclusion("C1", null, "COMP", "LOC");
  t("sem regra → não barrado, 0 chamadas", !r.excluded && ghlChamadas.length === 0);
  r = await checkContactExclusion("C1", semNegate, "COMP", "LOC");
  t("regras sem negate → não barrado, 0 chamadas", !r.excluded && ghlChamadas.length === 0);
  r = await checkContactExclusion("C1", msgNegada, "COMP", "LOC");
  t("só exclusão por mensagem → 0 chamadas", !r.excluded && ghlChamadas.length === 0);

  h("B2. Reaproveita o contato do caller (runner já fez o GET do DND)");
  zerar();
  r = await checkContactExclusion("C1", JUSSARA, "COMP", "LOC", { contact: contato(["active client"]) });
  t("contato passado → barrado sem GET", r.excluded && ghlChamadas.length === 0, JSON.stringify(r));

  h("B3. Busca o contato quando não vem pronto");
  zerar();
  ghlGet = async (p) => (p.startsWith("/contacts/") ? { contact: contato(["cliente"]) } : null);
  r = await checkContactExclusion("C1", JUSSARA, "COMP", "LOC");
  t("GET /contacts → barrado", r.excluded && ghlChamadas.length === 1 && ghlChamadas[0] === "/contacts/C1", JSON.stringify(ghlChamadas));
  ghlGet = async () => ({ contact: contato(["ctwa-lead"]) });
  r = await checkContactExclusion("C1", JUSSARA, "COMP", "LOC");
  t("GET /contacts sem tag de cliente → não barrado", !r.excluded && !r.erro);

  h("B4. FAIL-OPEN: erro de leitura nunca cala a IA");
  ghlGet = async () => { throw new Error("GHL API 503: upstream"); };
  r = await checkContactExclusion("C1", JUSSARA, "COMP", "LOC");
  t("GET lança → NÃO barrado + erro registrado", !r.excluded && /503/.test(r.erro || ""), JSON.stringify(r));
  ghlGet = async () => ({ contact: null });
  r = await checkContactExclusion("C1", JUSSARA, "COMP", "LOC");
  t("contato vazio → NÃO barrado + erro", !r.excluded && !!r.erro);
  r = await checkContactExclusion("C1", JUSSARA, null, "LOC");
  t("sem company_id pra buscar → NÃO barrado + erro", !r.excluded && !!r.erro);
  // O caso que o `.catch(() => null)` do gate completo erraria: exclusão de
  // "origem não preenchida" com o GET falhando viraria "contato sem origem" e
  // barraria POR ERRO. Aqui erro é erro.
  const origemNotSet: TargetingRuleSet = {
    version: 2, match: "all",
    groups: [{ id: "g", match: "all", rules: [{ id: "o", type: "attribution", attribution_operator: "not_set", negate: true }] }],
  };
  ghlGet = async () => { throw new Error("timeout"); };
  r = await checkContactExclusion("C1", origemNotSet, "COMP", "LOC");
  t("exclusão de origem com GET falhando → NÃO barra por erro", !r.excluded && !!r.erro);
  zerar();
  ghlGet = async (p) => {
    if (p.startsWith("/opportunities/")) throw new Error("GHL API 500");
    return { contact: contato([]) };
  };
  r = await checkContactExclusion("C1", etapa, "COMP", "LOC", { contact: contato([]) });
  t("exclusão por etapa com busca de opps falhando → NÃO barra", !r.excluded && !!r.erro);
  t("…e só buscou as opps (o contato veio pronto)", ghlChamadas.length === 1 && ghlChamadas[0].startsWith("/opportunities/"));

  /* ═══ C/D. ponta a ponta com Supabase falso ═══════════════════════════ */
  type Req = { method: string; table: string; q: URLSearchParams; body: Record<string, unknown> | null; accept: string; prefer: string };
  let reqs: Req[] = [];
  let rota: (r: Req) => unknown[] = () => [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== "sb.fake") throw new Error(`rede real bloqueada no teste: ${url.href}`);
    const headers = new Headers(init?.headers);
    const method = (init?.method || "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    const req: Req = {
      method,
      table: url.pathname.replace(/^\/rest\/v1\//, ""),
      q: url.searchParams,
      body,
      accept: headers.get("accept") || "",
      prefer: headers.get("prefer") || "",
    };
    reqs.push(req);
    const rows = rota(req) ?? [];
    const json = { "content-type": "application/json" };
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-0/${rows.length}` } });
    if (req.accept.includes("vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        return new Response(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }), { status: 406, headers: json });
      }
      return new Response(JSON.stringify(rows[0]), { status: 200, headers: json });
    }
    if (method !== "GET" && !req.prefer.includes("return=representation")) return new Response("", { status: method === "POST" ? 201 : 200 });
    return new Response(JSON.stringify(rows), { status: 200, headers: json });
  }) as typeof fetch;

  const { processMessageQueue } = await import("@/lib/queue/queue-processor");
  const { processScheduledFollowUps } = await import("@/lib/queue/follow-up-scheduler");

  const AGENTE = "a297dadc-873a-4803-885d-472c65414168";
  const LOC = "pGl5pqLLG0QDixANpFnP";
  const CONTATO = "CONTATO-TESTE-1";

  const configBase = {
    agent_id: AGENTE,
    enable_audio_transcription: false,
    enable_image_analysis: false,
    enable_pdf_reading: false,
    max_messages_per_conversation: null,
    entry_by_automation: false,
    enabled_channels: ["SMS", "WhatsApp"],
    deactivation_rules: null,
    follow_up_config: { enabled: true, mode: "manual", manual_steps: [{ delay_minutes: 120 }] },
  };
  const conversaAtiva = {
    agent_id: AGENTE, location_id: LOC, contact_id: CONTATO, conversation_id: "conv-1",
    status: "active", ai_paused_at: null, ai_paused_reason: null, ai_resumed_at: null,
    last_ai_response_at: "2026-09-28T15:00:00Z", message_count: 4, entry_suppressed_at: null,
    collected_data: {},
  };

  const logsDe = (tipo: string) =>
    reqs.filter((q) => q.table === "execution_log" && q.method === "POST" && q.body?.action_type === tipo);
  const cancelamentosDaSequencia = () =>
    reqs.filter((q) =>
      q.table === "scheduled_followups" && q.method === "PATCH" && q.body?.status === "cancelled" &&
      q.q.get("agent_id") === `eq.${AGENTE}` && q.q.get("contact_id") === `eq.${CONTATO}` &&
      (q.q.get("status") || "").startsWith("in."));
  // Primeira leitura que só acontece DEPOIS do gate de público no processor:
  // o turno seguiu pro pipeline de resposta.
  const seguiuProPipeline = () => reqs.some((q) => q.table === "location_settings");

  async function turno(cenario: {
    config: Record<string, unknown>;
    conv: Record<string, unknown> | null;
    ghl: (p: string) => Promise<unknown>;
    corpo?: string;
  }) {
    reqs = [];
    zerar();
    ghlGet = cenario.ghl;
    const agentRow = { id: AGENTE, type: "sales_agent", status: "active", location_id: LOC, name: "Jussara Lima - Vendas", agent_configs: { ...configBase, ...cenario.config } };
    const linha = {
      id: `mq-${Math.random().toString(36).slice(2, 8)}`, agent_id: AGENTE, location_id: LOC, contact_id: CONTATO,
      conversation_id: "conv-1", channel: "WhatsApp", message_body: cenario.corpo ?? "Oi, e a minha apólice?",
      received_at: new Date(Date.now() - 60_000).toISOString(), process_after: new Date(Date.now() - 1000).toISOString(),
      status: "processing", message_direction: "inbound", audio_url: null, media_attachments: null, retry_count: 0,
    };
    let claimou = false;
    rota = (q) => {
      if (q.table === "message_queue" && q.method === "PATCH") {
        if (q.q.get("status") === "eq.pending" && q.body?.status === "processing" && !claimou) {
          claimou = true;
          return [linha];
        }
        return [];
      }
      if (q.table === "agents") return q.q.get("id") ? [agentRow] : [];
      if (q.table === "conversation_state") return cenario.conv ? [cenario.conv] : [];
      if (q.table === "locations") {
        const sel = q.q.get("select") || "";
        if (sel === "wallet_blocked_at") return [{ wallet_blocked_at: null }];
        if (sel.startsWith("company_id")) return [{ company_id: "COMP", location_id: LOC }];
        return []; // select=* → o turno para logo depois do gate (sem LLM, sem envio)
      }
      return [];
    };
    const res = await processMessageQueue();
    return res;
  }

  h("C1. trigger_once + conversa ativa + etiqueta 'active client' → NÃO responde");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: JUSSARA },
    conv: conversaAtiva,
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato(["ctwa-lead", "active client"]) } : null),
  });
  let skips = logsDe("targeting_skip");
  t("gravou targeting_skip", skips.length === 1, `${skips.length}`);
  const p1 = (skips[0]?.body?.action_payload || {}) as Record<string, unknown>;
  t("payload marca exclusion:true, path inbound_turn e bypassed_by trigger_once",
    p1.exclusion === true && p1.path === "inbound_turn" && p1.bypassed_by === "trigger_once", JSON.stringify(p1));
  t("motivo legível com a etiqueta", /active client/.test(String(p1.reason)), String(p1.reason));
  t("cancelou a sequência de follow-up do contato", cancelamentosDaSequencia().length === 1);
  t("NÃO seguiu pro pipeline de resposta (sem LLM, sem envio)", !seguiuProPipeline());
  t("1 GET de contato (a exclusão)", ghlChamadas.filter((c) => c.startsWith("/contacts/")).length === 1, JSON.stringify(ghlChamadas));

  h("C2. trigger_once + conversa ativa + SEM etiqueta de cliente → responde normal");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: JUSSARA },
    conv: conversaAtiva,
    // entrou pela FRASE do anúncio: sem tag nenhuma. O gate completo barraria
    // o 2º turno; o trigger_once pula a inclusão e isso não pode mudar.
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato([]) } : null),
    corpo: "2",
  });
  t("nenhum targeting_skip", logsDe("targeting_skip").length === 0);
  t("seguiu pro pipeline de resposta", seguiuProPipeline());
  t("não cancelou follow-up", cancelamentosDaSequencia().length === 0);

  h("C3. trigger_once + conversa ativa + GET do contato falhando → fail-open (responde)");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: JUSSARA },
    conv: conversaAtiva,
    ghl: async () => { throw new Error("GHL API 503: upstream"); },
  });
  t("nenhum targeting_skip", logsDe("targeting_skip").length === 0);
  t("seguiu pro pipeline de resposta", seguiuProPipeline());

  h("C4. Retomada manual antiga (ai_resumed_at) não vence a exclusão");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: JUSSARA },
    conv: { ...conversaAtiva, ai_resumed_at: "2026-07-17T04:24:19Z" },
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato(["cliente"]) } : null),
  });
  skips = logsDe("targeting_skip");
  t("barrado mesmo com ai_resumed_at", skips.length === 1 && !seguiuProPipeline());
  await turno({
    config: { activation_mode: null, targeting_rules: BIANCA_TRAFEGO },
    conv: { ...conversaAtiva, ai_resumed_at: "2026-09-28T10:00:00Z" },
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato(["client"]) } : null),
  });
  skips = logsDe("targeting_skip");
  const p4 = (skips[0]?.body?.action_payload || {}) as Record<string, unknown>;
  t("gate_ongoing + retomada manual: exclusão vale, bypassed_by manual_resume",
    skips.length === 1 && p4.bypassed_by === "manual_resume" && p4.exclusion === true, JSON.stringify(p4));
  await turno({
    config: { activation_mode: null, targeting_rules: BIANCA_TRAFEGO },
    conv: { ...conversaAtiva, ai_resumed_at: "2026-09-28T10:00:00Z" },
    // sem nenhuma tag de entrada: a retomada manual continua vencendo a INCLUSÃO
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato([]) } : null),
  });
  t("retomada manual continua vencendo a INCLUSÃO (GU-6 intacto)", logsDe("targeting_skip").length === 0 && seguiuProPipeline());

  h("C5. gate_ongoing (caminho antigo) intacto");
  await turno({
    config: { activation_mode: null, targeting_rules: BIANCA_TRAFEGO },
    conv: conversaAtiva,
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato(["client"], { attributionSource: { sessionSource: "Paid Social" } }) } : null),
  });
  skips = logsDe("targeting_skip");
  const p5 = (skips[0]?.body?.action_payload || {}) as Record<string, unknown>;
  t("barra pelo gate completo, com o payload de sempre (sem exclusion)",
    skips.length === 1 && p5.exclusion === undefined && p5.reason === "regras de ativação não casaram", JSON.stringify(p5));
  t("sem avaliação dupla: 1 GET de contato só", ghlChamadas.filter((c) => c.startsWith("/contacts/")).length === 1, JSON.stringify(ghlChamadas));
  await turno({
    config: { activation_mode: null, targeting_rules: BIANCA_TRAFEGO },
    conv: conversaAtiva,
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato([], { attributionSource: { sessionSource: "Paid Social" } }) } : null),
  });
  t("lead de anúncio segue atendido", logsDe("targeting_skip").length === 0 && seguiuProPipeline());

  h("C6. Neutro não vira catch-all no turno");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: { ...soNeutra, groups: [...soNeutra.groups, JUSSARA.groups[0]] } },
    conv: conversaAtiva,
    ghl: async (p) => (p.startsWith("/contacts/") ? { contact: contato(["qualquer"]) } : null),
  });
  t("exclusão de tag vazia não barra", logsDe("targeting_skip").length === 0 && seguiuProPipeline());

  h("C7. trigger_once SEM exclusão: nada muda e custa zero");
  await turno({
    config: { activation_mode: "trigger_once", targeting_rules: { version: 2, match: "all", groups: [JUSSARA.groups[0]] } },
    conv: conversaAtiva,
    ghl: async () => { throw new Error("não devia chamar o Spark Leads no gate"); },
  });
  t("seguiu pro pipeline", logsDe("targeting_skip").length === 0 && seguiuProPipeline());
  t("zero GET no gate", ghlChamadas.length === 0, JSON.stringify(ghlChamadas));

  /* ═══ D. runner de follow-up ══════════════════════════════════════════ */
  async function toque(cenario: { config: Record<string, unknown>; tags: string[] }) {
    reqs = [];
    zerar();
    ghlGet = async (p) => {
      if (p.startsWith("/contacts/")) return { contact: { id: CONTATO, dnd: false, ...contato(cenario.tags) } };
      if (p.startsWith("/opportunities/")) return { opportunities: [] };
      throw new Error(`GET inesperado no runner: ${p}`);
    };
    const agentRow = { id: AGENTE, type: "sales_agent", status: "active", location_id: LOC, agent_configs: { ...configBase, ...cenario.config } };
    const fu = {
      id: "fu-1", agent_id: AGENTE, location_id: LOC, contact_id: CONTATO, conversation_id: "conv-1",
      attempt_number: 1, status: "processing", scheduled_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date(Date.now() - 3 * 3600_000).toISOString(), custom_message: null,
    };
    let claimou = false;
    rota = (q) => {
      if (q.table === "scheduled_followups" && q.method === "PATCH") {
        if (q.q.get("status") === "eq.pending" && q.body?.status === "processing" && !claimou) {
          claimou = true;
          return [fu];
        }
        return [];
      }
      if (q.table === "conversation_state") return [{ status: "active", collected_data: {}, conversation_id: "conv-1", ai_paused_at: null }];
      if (q.table === "locations") {
        const sel = q.q.get("select") || "";
        if (sel === "wallet_blocked_at") return [{ wallet_blocked_at: null }];
        if (sel.startsWith("company_id")) return [{ company_id: "COMP" }];
        return []; // select=* → o toque para aqui (sem LLM, sem envio)
      }
      if (q.table === "agent_configs") return [{ closed_opp_gate: null }];
      if (q.table === "agents") return [agentRow];
      return [];
    };
    return processScheduledFollowUps();
  }
  const passouDaExclusaoNoRunner = () => reqs.some((q) => q.table === "locations" && q.q.get("select") === "*");

  h("D1. Follow-up de contato que virou cliente → cancelado");
  await toque({ config: { activation_mode: "trigger_once", targeting_rules: JUSSARA }, tags: ["ctwa-lead", "apólice ativa"] });
  skips = logsDe("targeting_skip");
  const pd = (skips[0]?.body?.action_payload || {}) as Record<string, unknown>;
  t("gravou targeting_skip com path followup_runner e exclusion:true",
    skips.length === 1 && pd.path === "followup_runner" && pd.exclusion === true, JSON.stringify(pd));
  t("cancelou a sequência INTEIRA (agent+contact, pending/processing)", cancelamentosDaSequencia().length === 1);
  t("não seguiu pra geração/envio", !passouDaExclusaoNoRunner());
  t("reaproveitou o GET do DND (1 GET de contato só)", ghlChamadas.filter((c) => c.startsWith("/contacts/")).length === 1, JSON.stringify(ghlChamadas));

  h("D2. Follow-up de lead sem etiqueta de cliente → segue");
  await toque({ config: { activation_mode: "trigger_once", targeting_rules: JUSSARA }, tags: ["ctwa-lead"] });
  t("nenhum targeting_skip", logsDe("targeting_skip").length === 0);
  t("passou do gate de exclusão (seguiu pro envio)", passouDaExclusaoNoRunner());
  t("não cancelou a sequência", cancelamentosDaSequencia().length === 0);

  h("D3. Follow-up vale pra gate_ongoing também (Bianca: 'ia-desligada')");
  await toque({ config: { activation_mode: null, targeting_rules: BIANCA_SEGUIDORES }, tags: ["novo seguidor", "ia-desligada"] });
  t("cancelado", logsDe("targeting_skip").length === 1 && cancelamentosDaSequencia().length === 1 && !passouDaExclusaoNoRunner());

  h("D4. Agente sem exclusão: runner igual a antes");
  await toque({ config: { activation_mode: "trigger_once", targeting_rules: { version: 2, match: "all", groups: [JUSSARA.groups[0]] } }, tags: ["cliente"] });
  t("não barra (sem folha negate, nada muda)", logsDe("targeting_skip").length === 0 && passouDaExclusaoNoRunner());

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${ok}/${ok + fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
