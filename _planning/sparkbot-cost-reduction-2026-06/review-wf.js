export const meta = {
  name: 'sparkbot-cost-codereview',
  description: 'Ultra code-review do SparkBot focado em reducao de tokens/custo SEM perder qualidade: system prompt, 50+ tools, historico/memoria, cache+roteamento. 4 auditores + sintese.',
  phases: [
    { title: 'Auditar', detail: '4 agentes: prompt, tools, historico/memoria, cache/roteamento' },
    { title: 'Sintetizar', detail: 'lista unica de fixes priorizada (token x qualidade)' },
  ],
}

const CTX = 'CONTEXTO (medido em prod): SparkBot = 81% do custo de LLM (~$280/mes), ~177K tokens de INPUT por turno (Sonnet 4.6), output ~336 tok, cache 84% hit. Composicao do input: system prompt ~87K chars/~22K tok + definicoes de 50+ tools + historico de 30 turnos CRU (com transcricoes de audio e dumps de busca). Uso real das tools (30d): search_contacts 630, present_options 173, list_calendars 104, schedule_message_to_contact 82, create_appointment 72, create_note 57, get_free_slots 54, create_task 50; cauda longa raríssima (bulk/group-campaigns/task-orchestrator gated por flag, 1-6 usos). Achados da pesquisa a validar no codigo: (a) Resumo matinal proativo tem cache=0 (paga 36K tok cheios/disparo) — provavel invalidador silencioso; (b) ~6% dos turnos caem no fallback gpt-4.1; (c) SparkBot le 30 turnos crus de sparkbot_messages SEM comprimir (os agentes sales/recruit ja usam compressHistory com gpt-4.1-nano acima de 25 turns — assimetria). Objetivo: cortar tokens/custo sem perder qualidade + viabilizar 3 tiers por agente (Haiku/Sonnet/Opus, modelo FIXO por conversa pra nao invalidar cache).'

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['surface', 'findings'],
  properties: {
    surface: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'evidence', 'token_impact', 'quality_risk', 'fix', 'effort', 'where'], properties: {
      title: { type: 'string' },
      evidence: { type: 'string', description: 'O que o codigo faz hoje (com file:line/medida real).' },
      token_impact: { type: 'string', description: 'Quantos tokens/custo isso pesa ou economizaria.' },
      quality_risk: { type: 'string', description: 'Risco de perder qualidade no fix e como mitigar.' },
      fix: { type: 'string', description: 'Mudanca concreta.' },
      effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      where: { type: 'string', description: 'file:line.' },
    } } },
  },
}

const SURFACES = [
  { key: 'system-prompt', focus: 'AUDITE O SYSTEM PROMPT do SparkBot. Leia src/lib/account-assistant/prompt-builder.ts (buildSparkbotSystemPrompt e as funcoes que ele chama: buildMemorySection, buildSparkbotRuntimeContext, etc) + os modulos em src/lib/agent-platform/modules/{behavior,scheduling,channel,knowledge}.ts. MEÇA o tamanho aproximado de cada secao (chars/tokens) e identifique: (1) redundancia/verbosidade cortavel; (2) secoes que so importam em contexto especifico (ex: blocos gated de group-campaigns/task-orchestrator, secoes de canal, exemplos longos) que poderiam ser CONDICIONAIS em vez de sempre-presentes; (3) qualquer coisa volatil interpolada ANTES do fim do prompt que INVALIDE o cache (data/hora atual, nome do rep, location, timestamps) — isso transforma cache-read em re-write. Foque em cortar dos ~22K tokens sem perder regra de qualidade. Cite file:line e estime tokens.' },
  { key: 'tools', focus: 'AUDITE AS DEFINICOES DE TOOLS. Leia src/lib/account-assistant/tools/index.ts (registro) + as descriptions/parameters das tools (calendar.ts, contacts.ts, opportunities.ts, etc). Conte quantas tools sao registradas e estime o peso em tokens das definicoes (descriptions longas + JSON schemas). Cruze com o uso real (search_contacts/present_options/calendar/create_* sao quentes; bulk/group-campaigns/task-orchestrator/filter-engine sao cauda longa raríssima). Identifique: (1) descriptions verbosas demais (muitas tem paragrafos inteiros de instrucao que poderiam ir pro prompt ou encurtar); (2) candidatas a defer_loading/tool-search (cauda longa); (3) tools mortas/duplicadas. ATENCAO: mudar o tool set por turno invalida o cache (tools renderiza antes de system) — entao a recomendacao deve ser um SUBSET ESTAVEL por tipo de agente/tier, nao dinamico por turno. Cite file:line e estime tokens.' },
  { key: 'historico-memoria', focus: 'AUDITE O CARREGAMENTO DE HISTORICO E MEMORIA. Leia como o SparkBot monta as messages: o loader de sparkbot_messages (last 30 turns), processor.ts, e como tool_results entram no historico (transcricoes de audio, dumps de search_contacts/filter-engine/tabular). Compare com o compressHistory (gpt-4.1-nano) que os agentes sales/recruitment usam acima de 25 turns (procure compressHistory/summarize no codigo) — o SparkBot NAO comprime (assimetria a confirmar). Identifique: (1) o quanto o historico cru pesa (transcricoes de audio + dumps de busca sao os maiores); (2) onde aplicar summarization-buffer (manter ultimos N turnos crus + comprimir o resto com Haiku numa chamada SEPARADA) e/ou context-editing (limpar tool_results antigos re-buscaveis); (3) memoria persistente (perfil do rep/contato) que evitaria reenviar e reduziria alucinacao — o que ja existe (rep_identities.profile) e o que falta. Foque em cortar o bloco de historico sem perder fidelidade (preservar contact_id/nome/slot/decisoes). Cite file:line.' },
  { key: 'cache-roteamento', focus: 'AUDITE CACHE E ROTEAMENTO DE MODELO. Leia src/lib/account-assistant/llm-client.ts (como monta o request Anthropic: cache_control breakpoints, TTL, ordem tools/system/messages) + a cadeia de fallback (Sonnet 4.6 -> Haiku 4.5 -> gpt-4.1, STRICT_CLAUDE_ONLY) + onde o modelo e escolhido (ha selecao por agente/tier?). E o daily-briefing (proactive/daily-briefing.ts + daily-briefing-prompt.ts) que esta com cache=0. Identifique: (1) quantos cache breakpoints usam (max 4) e se a colocacao maximiza hit; TTL atual (5min) vs 1h pra reps idle; (2) o que faz o Resumo matinal nao cachear (prompt montado a cada vez sem cache_control? data no prefixo?); (3) por que ~6% caem no gpt-4.1 (parse fail? overload?) e o custo de cache cold ao trocar de provider/modelo; (4) onde encaixar a selecao de modelo por TIER (Haiku/Sonnet/Opus) FIXA por conversa sem quebrar cache. Cite file:line.' },
]

phase('Auditar')
const audits = (await parallel(SURFACES.map(s => () => agent(
  'Voce e engenheiro de performance/custo de LLM revisando o SparkBot (repo em CWD, branch main). Leia o codigo de verdade (Read/Grep) antes de afirmar — cite file:line e meça. ' + CTX + '\n\n=== SUA SUPERFICIE ===\n' + s.focus + '\n\nRetorne o schema com findings concretos: o que pesa, quanto economiza, risco de qualidade e como mitigar, o fix, esforco, file:line.',
  { label: 'audit:' + s.key, phase: 'Auditar', schema: SCHEMA, effort: 'high' }
)))).filter(Boolean)

const digest = audits.map(a => '### ' + a.surface + '\n' + (a.findings || []).map(f => '- ' + f.title + ' [' + f.effort + '] @' + f.where + '\n    evid: ' + f.evidence + '\n    impacto: ' + f.token_impact + ' | risco: ' + f.quality_risk + '\n    fix: ' + f.fix).join('\n')).join('\n\n')

log(audits.length + ' superficies auditadas. Sintetizando plano...')

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['narrative_md', 'fixes'],
  properties: {
    narrative_md: { type: 'string', description: 'Diagnostico do codigo + como os 3 tiers e o roteamento se encaixam, com numeros.' },
    fixes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'saving', 'effort', 'quality_risk', 'how', 'where'], properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      saving: { type: 'string', description: 'Economia estimada (tokens/% ou $).' },
      effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      quality_risk: { type: 'string', enum: ['none', 'low', 'med', 'high'] },
      how: { type: 'string' },
      where: { type: 'string' },
    } } },
  },
}

phase('Sintetizar')
const plan = await agent(
  'Voce e arquiteto de custo de LLM. Abaixo estao auditorias de 4 superficies do codigo do SparkBot. Sintetize num plano UNICO de reducao de custo sem perder qualidade, priorizado por ROI (economia x esforco x risco), e mostre como habilita os 3 tiers por agente + roteamento. ' + CTX + '\n\n=== AUDITORIAS ===\n' + digest + '\n\nRetorne o schema.',
  { label: 'plano', phase: 'Sintetizar', schema: PLAN_SCHEMA, effort: 'high' }
)

return { audits, plan }
