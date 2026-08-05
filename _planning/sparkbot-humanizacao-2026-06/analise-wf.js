export const meta = {
  name: 'sparkbot-humanizacao-analise',
  description: 'Analise de 7 dias de conversas reais do SparkBot (uso + comportamento) -> estudo + plano de humanizacao/orquestracao. 7 leitores de segmento -> 4 sintetizadores tematicos.',
  phases: [
    { title: 'Ler segmentos', detail: '7 agentes, 1 chunk de transcripts cada, achados com citacoes reais' },
    { title: 'Sintetizar temas', detail: '4 agentes: uso, naturalidade, orquestracao, erros — cruzam com o codigo' },
  ],
}

const DATA = '_planning/sparkbot-humanizacao-2026-06/data'
const NUM_CHUNKS = 7

const SEG_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reps_covered', 'use_cases', 'language_style', 'friction_points', 'robotic_moments', 'false_confirmations', 'what_worked_well', 'humanization_opportunities', 'orchestration_opportunities'],
  properties: {
    reps_covered: { type: 'array', items: { type: 'string' } },
    use_cases: { type: 'array', description: 'O que os reps usam o bot pra fazer, com frequencia e exemplo real.', items: { type: 'object', additionalProperties: false, required: ['task', 'note', 'example_quote'], properties: { task: { type: 'string' }, note: { type: 'string' }, example_quote: { type: 'string' } } } },
    language_style: { type: 'string', description: 'Como os reps FALAM: idioma (PT/EN/mix), audio vs texto, formalidade, girias, tamanho, pressa, emocional. Com exemplos.' },
    friction_points: { type: 'array', description: 'Onde o rep travou, se irritou, repetiu, ou o bot nao entregou. Citacao real + rep.', items: { type: 'object', additionalProperties: false, required: ['issue', 'evidence_quote', 'rep', 'severity'], properties: { issue: { type: 'string' }, evidence_quote: { type: 'string' }, rep: { type: 'string' }, severity: { type: 'string', enum: ['low', 'med', 'high'] } } } },
    robotic_moments: { type: 'array', description: 'Onde o bot soou robotico/burocratico/repetitivo: recapitula demais, pergunta o que ja sabe, confirma a toa, present_options forcado, linguagem dura.', items: { type: 'object', additionalProperties: false, required: ['what', 'evidence_quote', 'why_robotic'], properties: { what: { type: 'string' }, evidence_quote: { type: 'string' }, why_robotic: { type: 'string' } } } },
    false_confirmations: { type: 'array', description: 'Bot afirmou ter feito algo sem ter feito (feito sem tool), OU prometeu e nao cumpriu. Citacao.', items: { type: 'object', additionalProperties: false, required: ['evidence_quote', 'rep'], properties: { evidence_quote: { type: 'string' }, rep: { type: 'string' } } } },
    what_worked_well: { type: 'array', items: { type: 'string' }, description: 'Momentos em que o bot ajudou de verdade / soou natural — pra preservar.' },
    humanization_opportunities: { type: 'array', items: { type: 'string' }, description: 'Ideias concretas pra soar mais humano/natural baseadas NESSAS conversas.' },
    orchestration_opportunities: { type: 'array', items: { type: 'string' }, description: 'Valor proativo nao-explorado que apareceu: lembretes inteligentes, dicas, resumo de funil, numeros da conta, insights, proximos passos.' },
  },
}

phase('Ler segmentos')
const readerThunks = []
for (let i = 1; i <= NUM_CHUNKS; i++) {
  const prompt =
    'Voce e um analista de produto + conversational designer. Leia o ARQUIVO INTEIRO ' + DATA + '/chunk-' + i + '.txt ' +
    '(transcripts REAIS de conversas WhatsApp entre reps de seguros/financeiro e o SparkBot — assistente que opera o CRM "Spark Leads" por chat) e tambem ' + DATA + '/stats-7d.md pro contexto quantitativo.\n\n' +
    'Formato dos transcripts: [hora] ROLE (canal) {tools_usadas} <source> :: conteudo. ROLE=user e o rep, ROLE=agent e o SparkBot. Um marcador de microfone no inicio do conteudo = o rep mandou AUDIO (transcrito).\n\n' +
    'Sua missao: extrair observacoes REAIS e CITADAS (sempre com trecho literal curto + nome do rep) sobre: o que usam, COMO FALAM, onde travam/se irritam, onde o bot soa robotico, falsas confirmacoes, o que funcionou bem, e oportunidades de humanizacao + orquestracao proativa (lembretes/dicas/funil/numeros/insights).\n\n' +
    'Seja especifico e honesto — cite o que VIU, nao generalidades. Prefira poucos achados fortes e bem citados a muitos rasos. Retorne o schema.'
  readerThunks.push(() => agent(prompt, { label: 'seg:chunk-' + i, phase: 'Ler segmentos', schema: SEG_SCHEMA, effort: 'high' }))
}
const segFindings = (await parallel(readerThunks)).filter(Boolean)

const segDigest = segFindings.map((f, idx) => {
  const uc = (f.use_cases || []).map(u => '    - ' + u.task + ' — ' + u.note + ' | "' + u.example_quote + '"').join('\n')
  const fr = (f.friction_points || []).map(x => '    - [' + x.severity + '] ' + x.issue + ' (' + x.rep + ') "' + x.evidence_quote + '"').join('\n')
  const rb = (f.robotic_moments || []).map(x => '    - ' + x.what + ' — ' + x.why_robotic + ' | "' + x.evidence_quote + '"').join('\n')
  const fc = (f.false_confirmations || []).map(x => '    - (' + x.rep + ') "' + x.evidence_quote + '"').join('\n')
  const hu = (f.humanization_opportunities || []).map(x => '    - ' + x).join('\n')
  const orc = (f.orchestration_opportunities || []).map(x => '    - ' + x).join('\n')
  const ww = (f.what_worked_well || []).map(x => '    - ' + x).join('\n')
  return '### Segmento ' + (idx + 1) + ' (reps: ' + (f.reps_covered || []).join(', ') + ')\n' +
    '  LINGUAGEM: ' + f.language_style + '\n' +
    '  USE CASES:\n' + uc + '\n  FRICCAO:\n' + fr + '\n  ROBOTICO:\n' + rb + '\n  FALSAS CONFIRMACOES:\n' + fc + '\n  FUNCIONOU BEM:\n' + ww + '\n  HUMANIZACAO (ideias):\n' + hu + '\n  ORQUESTRACAO (ideias):\n' + orc
}).join('\n\n')

log(segFindings.length + ' segmentos lidos. Sintetizando 4 temas...')

const THEME_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['section_title', 'narrative_md', 'fixes'],
  properties: {
    section_title: { type: 'string' },
    narrative_md: { type: 'string', description: 'Analise em markdown (varias secoes, com dados e citacoes dos achados). Densa, especifica, acionavel.' },
    fixes: { type: 'array', description: 'Correcoes/melhorias concretas priorizadas.', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'problem', 'fix', 'effort', 'impact', 'where'], properties: {
      id: { type: 'string', description: 'ex H-1, N-3' },
      title: { type: 'string' },
      problem: { type: 'string', description: 'O que a evidencia mostra (com citacao).' },
      fix: { type: 'string', description: 'A mudanca concreta (prompt/tool/codigo/UX).' },
      effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      impact: { type: 'string', enum: ['low', 'med', 'high'] },
      where: { type: 'string', description: 'Arquivo/area provavel do fix (file:line se souber).' },
    } } },
  },
}

const THEMES = [
  { key: 'uso-comportamento', focus: 'TEMA 1 — ESTUDO DE USO & COMPORTAMENTO. Sintetize: quem sao os reps (segmentos: power users vs casuais; PT-BR vs US), o que mais fazem (ranqueado), COMO FALAM (audio load-bearing? idioma? pressa? tom?), os padroes de jornada (ex: pos-call -> nota+task; agendar->reagendar). Use os stats (' + DATA + '/stats-7d.md) + os achados. Os fixes aqui sao recomendacoes de produto/posicionamento (onde investir). NAO precisa ler muito codigo.' },
  { key: 'naturalidade-conversa', focus: 'TEMA 2 — NATURALIDADE CONVERSACIONAL (o coracao do pedido). Onde o bot soa robotico/burocratico e como deixar HUMANO, natural, agil. Leia o CODIGO que governa o tom/fluxo: src/lib/account-assistant/prompt-builder.ts (system prompt do SparkBot — tom, confirmacoes, present_options, verbosidade), src/lib/agent-platform/modules/behavior.ts, src/lib/account-assistant/conversational/ (turn-context, tones, verbosity), e a tool present_options. Cruze com os achados (robotic_moments, friction, false_confirmations). Fixes = mudancas concretas de prompt/UX pra fluencia: menos recap, menos confirmacao a toa, menos present_options forcado, linguagem mais quente, brevidade, memoria de contexto intra-conversa. Cite file:line onde der.' },
  { key: 'orquestracao-proatividade', focus: 'TEMA 3 — ORQUESTRACAO & PROATIVIDADE (lembretes, dicas, analise de funil, numeros da conta, insights). O Pedro quer o bot ajudando no dia-a-dia PROATIVAMENTE. Leia: src/lib/account-assistant/proactive/ (reaction-engine, reminder-runner, events, daily-briefing se existir), as tools de funil (tools/opportunities.ts, tools de analytics se houver), tools/reminders.ts, o orquestrador (task-orchestrator/). Cruze com orchestration_opportunities dos achados + os missed_capabilities dos stats. Fixes = capacidades proativas concretas: resumo de funil/numeros sob demanda e proativo, dicas contextuais, lembretes inteligentes, next-best-action, insights da conta. Diga o que JA existe vs o que falta construir. Cite file:line.' },
  { key: 'erros-friccao-capacidade', focus: 'TEMA 4 — ERROS RECORRENTES, FRICCAO & CAPACIDADES FALTANTES. O que o bot NAO consegue fazer com frequencia (dos achados + missed_capabilities + signals de erro nos stats). Agrupe: (a) capacidades pedidas e ausentes (templates de mensagem reutilizaveis, extracao de PDF de apolice, e-mail opcional no calendario, recorrencia, automacoes) — quais valem construir; (b) erros operacionais (slot ocupado, location not active, token/IAM, email invalido); (c) falsas confirmacoes / coherence-gate. Pode ler tools/ e docs/DECISIONS.md pra ver o que ja existe. Fixes priorizados com esforco x impacto. Cite file:line/area.' },
]

phase('Sintetizar temas')
const themeFindings = (await parallel(THEMES.map(t => () => agent(
  'Voce e arquiteto de produto + conversational designer do SparkBot. Abaixo estao os ACHADOS de 7 leitores que processaram 7 dias de conversas reais (2015 msgs, 28 reps). Sintetize SEU tema a fundo, cruzando com o codigo real do repo (CWD = raiz do repo, branch main).\n\n' +
  '=== ACHADOS DOS SEGMENTOS ===\n' + segDigest + '\n\n=== SEU TEMA ===\n' + t.focus + '\n\n' +
  'Entregue uma analise densa e especifica (narrative_md) + uma lista de fixes priorizados (esforco x impacto, com onde mexer). Funde no que a EVIDENCIA real mostra — cite trechos. Retorne o schema.',
  { label: 'tema:' + t.key, phase: 'Sintetizar temas', schema: THEME_SCHEMA, effort: 'high' }
)))).filter(Boolean)

return { segFindings, themeFindings }
