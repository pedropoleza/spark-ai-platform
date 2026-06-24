export const meta = {
  name: 'sparkbot-cost-research',
  description: 'Pesquisa web de estrategias de reducao de tokens/custo sem perder qualidade: compressao de contexto, roteamento multi-modelo, memoria (curto/longo prazo anti-alucinacao), prompt caching. 4 frentes + sintese.',
  phases: [
    { title: 'Pesquisa', detail: '4 agentes web: compressao, roteamento, memoria, cache' },
    { title: 'Sintese', detail: 'cruza as 4 frentes com o nosso stack' },
  ],
}

const STACK = 'NOSSO STACK (pra contextualizar a aplicabilidade): assistente WhatsApp (SparkBot) + agentes lead-facing (venda/recrutamento) em Next.js 14 + Supabase, usando Claude via API Anthropic (primario Sonnet 4.6, fallback Haiku 4.5, fallback GPT-4.1 OpenAI). MEDIDO em prod: ~177K tokens de INPUT por turno (prompt de sistema de ~87K chars/~22K tokens + definicoes de 50+ tools + historico de 30 turnos com transcricoes de audio e dumps de busca), output minusculo (~336 tokens). Cache JA ligado: 83% de hit (cache-read). Pricing: Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5 por 1M (in/out); cache-read ~0.1x input, cache-write 1.25x (TTL 5min)/2x (TTL 1h). Trocar de modelo no meio da conversa INVALIDA o cache. Objetivo: reduzir custo SEM perder qualidade da conversa; queremos 3 tiers por agente (barato/medio/avancado) inclusive pro SparkBot. Futuro: orquestracao de workflows (webhooks, multi-mensagens, follow-ups grandes) que exigem memoria/contexto alargado.'

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'techniques', 'sources', 'applicability_to_us'],
  properties: {
    area: { type: 'string' },
    techniques: { type: 'array', description: 'Cada tecnica concreta encontrada.', items: { type: 'object', additionalProperties: false, required: ['name', 'how_it_works', 'token_or_cost_impact', 'quality_risk', 'evidence'], properties: {
      name: { type: 'string' },
      how_it_works: { type: 'string' },
      token_or_cost_impact: { type: 'string', description: 'Quanto economiza (qualitativo/quantitativo) e como.' },
      quality_risk: { type: 'string', description: 'Risco de perda de qualidade e como mitigar.' },
      evidence: { type: 'string', description: 'Numero/benchmark/citacao da fonte que sustenta.' },
    } } },
    sources: { type: 'array', items: { type: 'string' }, description: 'URLs das fontes confiaveis consultadas.' },
    applicability_to_us: { type: 'string', description: 'O que se aplica AO NOSSO STACK especificamente, ranqueado por ROI, com o porque.' },
  },
}

const AREAS = [
  { key: 'compressao-contexto', q: 'AREA 1 — REDUCAO DE TOKENS / COMPRESSAO DE CONTEXTO sem perder qualidade. Pesquise (WebSearch + WebFetch em fontes confiaveis: docs Anthropic e OpenAI, papers, blogs de engenharia tipo Anthropic, LangChain, LlamaIndex, Pinecone): system-prompt compression/distillation, context editing (limpar tool results antigos), compaction/summarization de historico, tool subsetting / tool-search (carregar so as tools relevantes), reducao de definicoes de tools, output brevity, structured outputs pra cortar verbosidade, programmatic tool calling (resultados grandes filtrados antes do contexto). Foque no que ataca os 177K tokens de input/turno do nosso caso.' },
  { key: 'roteamento-modelos', q: 'AREA 2 — ROTEAMENTO MULTI-MODELO E CASCATAS pra custo-beneficio. Pesquise: RouteLLM, model cascades, classifier-based routing (mandar turnos simples pro modelo barato e complexos pro caro), quando usar Haiku vs Sonnet vs Opus vs GPT-4.1/mini/nano, offload de subtarefas pra subagentes baratos (ex: Explore subagents com Haiku), o gotcha de que trocar de modelo no meio da conversa invalida o cache (e como contornar: roteamento por-conversa, subagente separado). Como montar uma orquestracao limpa de roteamento com 3 tiers por agente.' },
  { key: 'memoria', q: 'AREA 3 — MEMORIA (curto e longo prazo) pra conversa natural e ANTI-ALUCINACAO. Pesquise: MemGPT/Letta, memoria episodica vs semantica, summarization buffer, RAG-based memory, memory tool da Anthropic (/memories), vector memory por usuario, "agentic memory", como persistir fatos do usuario sem reenviar todo o historico (reduz tokens E alucinacao), estrategias de short-term (working memory da conversa) vs long-term (perfil persistente). Como uma memoria personalizada por agente deixa a conversa mais natural e reduz tokens.' },
  { key: 'prompt-caching', q: 'AREA 4 — PROMPT CACHING (a fundo, Anthropic e OpenAI). Pesquise nas docs: como funciona o cache de prefixo, cache_control breakpoints (max 4), TTL 5min vs 1h e o break-even (1.25x vs 2x write), minimo cacheavel por modelo, render order tools->system->messages, silent invalidators (timestamp/uuid/json nao-ordenado/tool set variavel), 20-block lookback, pre-warming (max_tokens:0), como estruturar o prompt pra maximizar hit num cenario de 30s cron + reps idle, diferenca do auto-caching da OpenAI. Dado que ja temos 83% hit, o que falta pra chegar a ~95% e como o TTL de 1h ajudaria reps idle.' },
]

phase('Pesquisa')
const findings = (await parallel(AREAS.map(a => () => agent(
  'Voce e um pesquisador de engenharia de LLM. Faca pesquisa web REAL (WebSearch + WebFetch nas fontes; cite URLs) sobre a area abaixo e devolva tecnicas concretas, com impacto de custo/token, risco de qualidade, e evidencia (numero/benchmark). Priorize fontes confiaveis (docs oficiais Anthropic/OpenAI, papers arXiv, blogs de eng reconhecidos).\n\n' + STACK + '\n\n=== SUA AREA ===\n' + a.q + '\n\nRetorne o schema. Seja concreto e honesto sobre trade-offs.',
  { label: 'pesq:' + a.key, phase: 'Pesquisa', schema: SCHEMA, effort: 'high' }
)))).filter(Boolean)

const digest = findings.map((f, i) => {
  const t = (f.techniques || []).map(x => '    - ' + x.name + ': ' + x.how_it_works + ' | impacto: ' + x.token_or_cost_impact + ' | risco: ' + x.quality_risk + ' | evid: ' + x.evidence).join('\n')
  return '### ' + (f.area || AREAS[i].key) + '\n' + t + '\n  APLICABILIDADE: ' + f.applicability_to_us + '\n  FONTES: ' + (f.sources || []).join(' ; ')
}).join('\n\n')

log(findings.length + ' frentes pesquisadas. Sintetizando...')

const SYN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['narrative_md', 'ranked_levers'],
  properties: {
    narrative_md: { type: 'string', description: 'Sintese em markdown das 4 frentes aplicada ao nosso stack: o que adotar, em que ordem, com numeros.' },
    ranked_levers: { type: 'array', description: 'Alavancas de reducao de custo ranqueadas por ROI.', items: { type: 'object', additionalProperties: false, required: ['lever', 'expected_saving', 'effort', 'quality_risk', 'how'], properties: {
      lever: { type: 'string' },
      expected_saving: { type: 'string', description: 'Estimativa de economia (%/$ ou tokens) com base nas evidencias.' },
      effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      quality_risk: { type: 'string', enum: ['none', 'low', 'med', 'high'] },
      how: { type: 'string', description: 'Como implementar no nosso stack.' },
    } } },
  },
}

phase('Sintese')
const synth = await agent(
  'Voce e arquiteto de LLM cost-optimization. Abaixo estao achados de 4 frentes de pesquisa (compressao, roteamento, memoria, caching). Sintetize pro NOSSO STACK e ranqueie as alavancas por ROI (economia x esforco x risco de qualidade). Use os numeros das evidencias. Seja especifico sobre o caso dos 177K tokens/turno e do objetivo de 3 tiers por agente.\n\n' + STACK + '\n\n=== ACHADOS ===\n' + digest + '\n\nRetorne o schema.',
  { label: 'sintese', phase: 'Sintese', schema: SYN_SCHEMA, effort: 'high' }
)

return { findings, synth }
