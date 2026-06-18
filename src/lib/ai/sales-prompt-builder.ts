import type { AgentConfig, DataField } from "@/types/agent";
import { getTimezoneFromState, getCurrentTimeInTimezone } from "@/lib/utils/timezone";
import { composePersonalityProfile } from "@/lib/ai/behavior-blocks";
import { isHumanOutboundSource } from "@/lib/ghl/message-sources";

/**
 * Sanitiza texto para prevenir prompt injection.
 * Remove caracteres que poderiam quebrar o prompt ou injetar instruções.
 */
function sanitize(text: string, maxLength = 200): string {
  return text
    .replace(/[#\n\r]/g, " ")  // Remove headers markdown e quebras de linha
    .replace(/\s+/g, " ")       // Normaliza espaços
    .trim()
    .substring(0, maxLength);
}

/**
 * Busca o valor de um campo nos dados coletados.
 * Tenta match por: key, ghl_field_id, ghl_field_key, label (case insensitive).
 */
function findFieldValue(field: DataField, data: Record<string, string>): string | undefined {
  if (data[field.key]) return data[field.key];
  if (field.ghl_field_id && data[field.ghl_field_id]) return data[field.ghl_field_id];
  if (field.ghl_field_key && data[field.ghl_field_key]) return data[field.ghl_field_key];

  const keyLower = field.key.toLowerCase();
  const labelLower = field.label.toLowerCase();
  const labelSnake = field.label.toLowerCase().replace(/\s+/g, "_");

  for (const [k, v] of Object.entries(data)) {
    const kLower = k.toLowerCase();
    if (kLower === keyLower || kLower === labelLower || kLower === labelSnake) return v;
  }

  return undefined;
}

interface FeedbackItem {
  rating: "positive" | "negative";
  ai_message: string;
  suggestion?: string;
}

export interface KnowledgeBaseItem {
  title: string;
  type: "text" | "file" | "url";
  content: string;
  file_name?: string | null;
  file_url?: string | null;
  description?: string | null;
  usage_instructions?: string | null;
}

export interface PromptContext {
  config: AgentConfig;
  agentType?: "sales_agent" | "recruitment_agent" | "custom_agent";
  contactName: string;
  collectedData: Record<string, string>;
  locationName: string;
  currentDate: string;
  timezone: string;
  availableSlots?: string;
  /**
   * true quando o fetch de slots falhou (após retries). A IA deve prometer
   * voltar com horários em vez de inventar ou assumir disponibilidade.
   */
  slotsUnavailable?: boolean;
  feedback?: FeedbackItem[];
  knowledgeBase?: KnowledgeBaseItem[];
  /**
   * Quantidade de turns JÁ trocados antes da mensagem atual (0 = primeira
   * mensagem do lead, sem resposta ainda). Usado para impedir que a IA
   * repita a saudação inicial em turnos posteriores. O sinal "primeira
   * mensagem" via texto no prompt é fraco; turnCount é inequívoco.
   */
  priorTurnCount?: number;
  /**
   * F37 (Pedro 2026-05-29): histórico completo do contato no Spark Leads
   * (msgs anteriores, notas, opp stage, tags). Opt-in via
   * `config.lead_history_config.enabled`. Quando presente, vira seção
   * "HISTÓRICO ANTERIOR DESSE LEAD" no system prompt.
   */
  leadHistory?: import("@/types/agent").LeadContext;
}

/**
 * System prompt ESTÁVEL — derivado apenas de AgentConfig + dados imutáveis dentro
 * de uma conversa (contactName, locationName). NÃO inclui data/hora, valores
 * coletados atuais, slots disponíveis. Esses vão em buildRuntimeContext e são
 * injetados na user message. Isso mantém o prefixo do system prompt byte-exact
 * entre turnos, maximizando o hit rate do prompt caching (OpenAI/Anthropic).
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  if (ctx.config.system_prompt_override) {
    // Fix HIGH-7 (deep review 2026-05-05): antes, override SHORT-CIRCUITAVA
    // pulando recruitment guard, KB, identity, booking. Resultado: agente
    // recruitment com override virava "vendedor" silenciosamente. Agora
    // override SUBSTITUI custom_instructions/objective mas mantém sections
    // críticas (anti-vendas no recruitment, KB, identity, booking format,
    // responseFormat) — admin pode customizar voz/tom mas não consegue
    // contornar regras de produto.
    const dataContext = ctx.config.data_fields.length > 0
      ? buildDataFieldsTemplateSection(ctx)
      : "";
    return [
      buildMetaInstruction(),
      buildIdentitySection(ctx),                   // identidade humana/IA
      ctx.config.system_prompt_override,
      buildKnowledgeBaseSection(ctx),              // KB
      buildRecruitmentSection(ctx),                // anti-vendas em recruitment
      buildBookingSection(ctx),                    // ISO 8601 + tz rules
      buildMediaInstructionsSection(ctx.config),
      dataContext,
      buildResponseFormatSection(ctx),
    ].filter(Boolean).join("\n\n");
  }

  const sections = [
    buildMetaInstruction(),
    buildTypeFramingSection(ctx),
    buildIdentitySection(ctx),
    // F37: histórico do lead vem ANTES das instruções do admin pra LLM
    // contextualizar antes de receber regras.
    buildLeadHistorySection(ctx),
    buildCustomInstructionsSection(ctx),
    buildExamplesSection(ctx),
    buildKnowledgeBaseSection(ctx),
    buildObjectiveSection(ctx),
    buildRecruitmentSection(ctx),
    buildToneSection(ctx),
    buildDataFieldsTemplateSection(ctx),
    buildConversationRulesSection(ctx),
    buildMediaInstructionsSection(ctx.config),
    buildBookingSection(ctx),
    buildFeedbackSection(ctx),
    buildResponseFormatSection(ctx),
  ];

  return sections.filter(Boolean).join("\n\n");
}

// ===================================================================
// PLATAFORMA MODULAR (Fase 2) — fragmentos de módulo lead-facing
// ===================================================================
// Mapa `moduleKey → fragmento(ctx)`. Reusa as section functions privadas deste
// arquivo (que JÁ eram modulares) sem expô-las soltas. Consumido pelo assembler
// (`assembleLeadFromModules`) pra COMPOR o prompt de um agente CUSTOM a partir
// dos módulos que ele ligou — em qualquer subset/ordem. (Os templates seed
// sales/recruitment continuam delegando pro buildSystemPrompt acima → paridade.)
// compliance/bulk/active_hours ainda não têm fragmento dedicado lead-facing
// (conteúdo a definir) — ficam de fora da composição por ora.
export const LEAD_MODULE_FRAGMENTS: Record<string, (ctx: PromptContext) => string> = {
  behavior: (ctx) =>
    [
      buildTypeFramingSection(ctx),
      buildIdentitySection(ctx),
      buildConversationRulesSection(ctx),
      buildExamplesSection(ctx),
      buildToneSection(ctx),
      buildResponseFormatSection(ctx),
    ]
      .filter(Boolean)
      .join("\n\n"),
  qualification: (ctx) =>
    [buildObjectiveSection(ctx), buildDataFieldsTemplateSection(ctx)].filter(Boolean).join("\n\n"),
  scheduling: (ctx) =>
    [buildBookingSection(ctx), buildPostBookingInstructions(ctx), buildRescheduleInstructions(ctx)]
      .filter(Boolean)
      .join("\n\n"),
  channel: (ctx) => buildMediaInstructionsSection(ctx.config),
  knowledge: (ctx) => buildKnowledgeBaseSection(ctx),
  followup: (ctx) => buildFeedbackSection(ctx),
};

/** Instrução-meta base (sempre presente, independe de módulo). */
export function buildLeadMetaInstruction(): string {
  return buildMetaInstruction();
}

/** Keys de módulo que têm fragmento lead-facing implementado hoje. */
export function leadModuleKeys(): string[] {
  return Object.keys(LEAD_MODULE_FRAGMENTS);
}

/**
 * Contexto VOLÁTIL — muda a cada turno. Injetado na user message, NUNCA no
 * system prompt, para preservar cache hit. Contém: data/hora atual, estado dos
 * dados coletados, horários disponíveis.
 */
export function buildRuntimeContext(ctx: PromptContext): string {
  const parts: string[] = [];

  const turnCount = ctx.priorTurnCount ?? 0;
  const isFirstTurn = turnCount === 0;
  const configuredGreeting = ctx.config.personality?.greeting_style?.trim();
  const agentName = ctx.config.personality?.name?.trim() || "";

  // Estado do turno é o ÚNICO lugar que controla saudação/apresentação.
  // System prompt não menciona greeting — evita que o modelo reproduza mesmo
  // quando a regra diz pra não repetir.
  let turnStateBlock: string;
  if (isFirstTurn) {
    turnStateBlock = configuredGreeting
      ? `ESTADO: PRIMEIRA mensagem da conversa.
Comece sua resposta com esta saudação (adaptando se o lead já tiver dito o nome dele): "${configuredGreeting}"
Esta saudação é USADA APENAS AGORA. Em turnos futuros NUNCA repita.`
      : `ESTADO: PRIMEIRA mensagem da conversa. Use uma saudação natural e breve.`;
  } else {
    const nameBan = agentName
      ? `, nem "${agentName}"`
      : "";
    turnStateBlock = `ESTADO: TURNO ${turnCount + 1} da conversa (já houve ${turnCount} troca${turnCount > 1 ? "s" : ""}).
REGRA ABSOLUTA DE NÃO-REPETIÇÃO:
- VOCÊ JÁ SE APRESENTOU em turno anterior. NÃO se apresente de novo.
- NÃO comece com "oi", "olá", "ei", "e aí", "tudo bem", "bom dia", "boa tarde", "boa noite"${nameBan}.
- NÃO repita seu nome próprio nem o da empresa.
- Comece a resposta DIRETO no assunto da mensagem do lead. Primeira palavra deve ser parte da resposta, não saudação.`;
  }

  parts.push(`## CONTEXTO ATUAL
Data/hora agora: ${ctx.currentDate}
Timezone: ${ctx.timezone}
${turnStateBlock}`);

  if (ctx.config.data_fields.length > 0) {
    const collected: string[] = [];
    const pending: string[] = [];
    for (const field of ctx.config.data_fields) {
      const value = findFieldValue(field, ctx.collectedData);
      if (value) {
        const skip = field.skip_if_filled !== false ? " [NÃO PERGUNTAR — já preenchido]" : "";
        collected.push(`- ${field.key}: "${value}"${skip}`);
      } else if (field.required) {
        pending.push(field.label);
      }
    }
    const collectedBlock = collected.length > 0 ? collected.join("\n") : "(nenhum dado coletado ainda)";
    const pendingLine = pending.length > 0
      ? `\nFaltam: ${pending.join(", ")}`
      : "\n✅ TODOS OBRIGATÓRIOS COLETADOS — pode seguir para agendamento";
    parts.push(`### DADOS JÁ COLETADOS\n${collectedBlock}${pendingLine}`);
  }

  if (ctx.config.objective !== "qualification_only") {
    if (ctx.slotsUnavailable) {
      parts.push(`### AGENDA INDISPONÍVEL NO MOMENTO
Não foi possível consultar a agenda agora (falha temporária).
Se o lead pedir para agendar: diga naturalmente "Deixa eu confirmar a agenda aqui e te volto em instantes" e peça o intervalo preferido (dia + turno).
NÃO invente horários. NÃO inclua action book_appointment neste turno.`);
    } else if (ctx.availableSlots) {
      const tzConfig = ctx.config.timezone_config;
      let effectiveTimezone = ctx.timezone;

      if (tzConfig?.auto_detect_from_state) {
        const stateValue = ctx.collectedData["contact.state"] || ctx.collectedData["state"] ||
          ctx.collectedData["estado_onde_mora"] || ctx.collectedData["estado"] || "";
        if (stateValue) {
          const detectedTz = getTimezoneFromState(stateValue);
          if (detectedTz) effectiveTimezone = detectedTz;
        }
      }
      if (tzConfig && !tzConfig.use_location_default && tzConfig.custom_timezone) {
        effectiveTimezone = tzConfig.custom_timezone;
      }

      const currentTime = getCurrentTimeInTimezone(effectiveTimezone);
      parts.push(`### HORÁRIOS DISPONÍVEIS (use APENAS estes — não invente)
Agora no timezone do lead: ${currentTime}
${ctx.availableSlots}

Ao PROPOR, ofereça 2 opções ESPAÇADAS (ex: uma mais cedo e uma mais tarde, ou manhã e tarde) — nunca duas coladas tipo "11:30 ou 12:00".
Se o lead perguntar "qual o último horário?" ou um horário específico, responda SEMPRE com base na lista acima (ela já mostra o último horário real de cada dia). Nunca diga que um horário não existe sem checar a lista.`);
    } else {
      // F24 BUG-1 fix (Pedro 2026-05-28 smoke): quando NEM slots NEM
      // slotsUnavailable foram passados, prompt antigo deixava vácuo →
      // modelo inventava "amanhã 11 AM ou 2 PM ET". Agora bloqueio explícito.
      parts.push(`### AGENDA AINDA NÃO CONSULTADA
Não tenho a lista de horários disponíveis nesta mensagem.
Se o lead pedir agendamento OU se for o momento de propor, pergunte o intervalo preferido (dia + turno tipo "manhã/tarde") e diga: "Deixa eu verificar a agenda aqui e volto em instantes com horários reais."
NUNCA mencione horários específicos (ex: "amanhã 11 AM" ou "2 PM ET") quando esta seção não tem slots reais.
NÃO inclua action book_appointment neste turno.`);
    }
  }

  return parts.join("\n\n");
}

function buildMetaInstruction(): string {
  return `## DIRETRIZ PRINCIPAL
Você é um conversador INTELIGENTE e NATURAL via WhatsApp/SMS.

PRIORIDADES (nesta ordem):
1. Siga as INSTRUÇÕES DO ADMINISTRADOR, elas definem o tom, fluxo e abordagem da conversa
2. Seja HUMANO e FLUIDO, nunca pareça formulário, robô ou script
3. AVANCE a conversa a cada mensagem, nunca repita, nunca estagne
4. Colete informações de forma NATURAL dentro da conversa, não como interrogatório
5. Quando o lead demonstrar interesse, AGENDE, não prolongue desnecessariamente

============================================================
REGRAS ABSOLUTAS (VALEM SEMPRE, TODO TURNO, SEM EXCEÇÃO)
============================================================

REGRA 1 — NÃO SE APRESENTE DUAS VEZES:
Sua apresentação (nome, "oi", "olá", "sou X", "aqui é o X", "da empresa Y")
acontece APENAS na PRIMEIRA mensagem da conversa. A partir do 2º turno,
NUNCA mais comece mensagem com saudação ou auto-apresentação.
- PROIBIDO em turnos 2+: "Oi", "Olá", "E aí", "Ei", "Bom dia", "Boa tarde",
  "Boa noite", "Tudo bem?", "Tudo bem por aqui", "Sou [nome]",
  "Aqui é o [nome]", "Da [empresa]", "Da equipe da [empresa]", emoji de
  cumprimento no começo (😄, 👋, 🙌).
- Em turnos 2+ comece DIRETO no conteúdo da resposta. Primeira palavra
  deve ser parte da resposta, não saudação.

REGRA 2 — NÃO USE TRAVESSÃO:
NUNCA escreva "—" (travessão longo) ou "–" (travessão curto). Ninguém
digita isso no WhatsApp, parece robô copy-paste. Use vírgula, ponto,
dois pontos ou parênteses no lugar. Também evite reticências longas
("..."). Prefira frases curtas conectadas com vírgula ou ponto.

REGRA 3 — NÃO INVENTE CLAIMS NUMÉRICOS:
Você NUNCA cita números (porcentagens, valores em $, prazos específicos,
quantidades de clientes, taxas) que não foram explicitamente fornecidos
em: INSTRUÇÕES CUSTOMIZADAS, BASE DE CONHECIMENTO ou CONTEXTO ATUAL.
- PROIBIDO: "muitos clientes economizaram até 20%", "98% de satisfação",
  "preços a partir de R$ 50", "mais de 1000 famílias atendidas",
  "redução média de X%", "em até 24h", "garantimos Y" (se Y é número).
- PERMITIDO: "muitos clientes conseguem economizar" (sem número),
  "o especialista vai te passar os valores", "depende do perfil" (vago).
- Se o lead pedir números: diga "o especialista vai te passar números
  exatos na conversa" ou peça pra confirmar com a equipe.
- Isso é REGULATÓRIO em mercados como seguros e saúde — claim falso
  pode gerar violação de CDC e problemas com a agência.

REGRA 4 — NÃO INVENTE O NOME DO LEAD:
O nome do lead vem APENAS de: (a) os dados do contato no CONTEXTO ATUAL
(contact.firstName / contact.name), ou (b) o que o PRÓPRIO lead te disser
nesta conversa. Se NENHUM dos dois tiver o nome, você NÃO SABE o nome —
NUNCA invente, chute ou presuma (nem o nome, nem o gênero).
- Se o lead provocar ("não sabe meu nome?", "não tem meu nome aí?"), seja
  honesto e leve: "Ainda não 😅 me fala como você prefere que eu te chame?".
  PROIBIDO responder inventando ("tem sim, [nome]!").
- Fix bug observado em prod 2026-06-08: a IA chamou "Marcos" de "Gisa" —
  confabulou um nome sob pressão social em vez de admitir que não tinha.
============================================================`;
}

/**
 * Enquadramento fundamental do tipo de agente. Aparece SEMPRE, logo após a
 * diretriz principal. Sem isso, se custom_instructions/personality estiverem
 * vazios, sales e recruitment geram conversas praticamente idênticas — foi
 * exatamente o sintoma reportado ("os 2 atendimentos iguais no teste").
 *
 * Diferença crítica: sales trata o contato como CLIENTE potencial (compra);
 * recruitment trata como CANDIDATO a oportunidade de carreira (não é venda).
 */
function buildTypeFramingSection(ctx: PromptContext): string {
  if (ctx.agentType === "recruitment_agent") {
    return `## NATUREZA DO ATENDIMENTO: RECRUTAMENTO
Você é um agente de RECRUTAMENTO. Sua função é qualificar CANDIDATOS interessados em uma OPORTUNIDADE DE CARREIRA e agendar uma conversa com o especialista responsável.

REGRAS INVIOLÁVEIS DE RECRUTAMENTO:
- Trate o contato como CANDIDATO, nunca como cliente/comprador.
- Isto NÃO é venda. Você NÃO está oferecendo produto, serviço ou contratação de seguro.
- Você está apresentando uma OPORTUNIDADE PROFISSIONAL/CARREIRA.
- NUNCA use linguagem comercial: "contratar", "adquirir", "cotação", "orçamento", "proteção", "cobertura", "apólice", "prêmio", "plano".
- Se o candidato perguntar "voces vendem seguro?" ou similar: reframe para "oportunidade profissional" e deixe que o especialista explique na conversa.
- O agendamento é para o candidato CONHECER a oportunidade, não para fechar nada.
- Nunca fale em valores, comissões, custos de licença ou estrutura de remuneração — isso é com o especialista.`;
  }

  if (ctx.agentType === "sales_agent") {
    return `## NATUREZA DO ATENDIMENTO: VENDAS
Você é um agente de VENDAS/QUALIFICAÇÃO. Sua função é qualificar LEADS interessados em um produto/serviço e agendar uma conversa com o corretor/consultor responsável.

REGRAS INVIOLÁVEIS DE VENDAS:
- Trate o contato como LEAD/CLIENTE potencial, pessoa interessada em contratar algo.
- Isto NÃO é recrutamento. Você NÃO está oferecendo vaga de emprego, oportunidade de carreira, ou profissionalização.
- NUNCA use linguagem de recrutamento: "candidato", "vaga", "oportunidade de carreira", "trabalhar conosco", "fazer parte do time", "desenvolvimento profissional".
- Se o lead perguntar "é oportunidade de trabalho?" ou similar: esclareça gentilmente que é sobre o produto/serviço e direcione para o que o corretor pode apresentar.
- O agendamento é para o lead conversar com um especialista sobre contratação/cotação.`;
  }

  // C2-4 (ultra-review 2026-05-26): custom_agent NÃO é forçado a vendas/recrutamento.
  // Enquadramento neutro que defere ao custom_instructions como diretriz principal —
  // sem REGRAS INVIOLÁVEIS comerciais que brigam com um propósito não-comercial.
  if (ctx.agentType === "custom_agent") {
    return `## NATUREZA DO ATENDIMENTO: PERSONALIZADO
Este é um agente PERSONALIZADO. Sua função, tom e regras vêm das INSTRUÇÕES CUSTOMIZADAS e do OBJETIVO definidos abaixo — trate-os como sua diretriz principal.

REGRAS:
- NÃO assuma que é venda nem recrutamento por padrão. Siga exatamente o propósito descrito nas instruções customizadas.
- Não force linguagem comercial ("cotação", "apólice", "contratar") nem de recrutamento ("vaga", "candidato", "carreira"), a menos que as instruções peçam.
- Se as instruções não cobrirem uma situação, seja útil, claro e neutro.`;
  }

  return "";
}

function buildIdentitySection(ctx: PromptContext): string {
  const p = ctx.config.personality;
  const name = sanitize(p?.name || "Assistente", 50);
  const locName = sanitize(ctx.locationName, 100);
  const isHuman = p?.identity_mode === "human";

  let identity: string;
  if (isHuman) {
    identity = `Você é ${name}, da equipe da ${locName}. Você é uma PESSOA REAL, não um software.
Se perguntarem se é robô/bot/IA: negue naturalmente ("Não haha, sou ${name}, da equipe da ${locName}").
Nunca use: "assistente", "assistente virtual", "IA", "bot", "robô", "automatizado".`;
  } else {
    identity = `Você é ${name}, da equipe da ${locName}.`;
  }

  const persona = p?.persona_description ? `\nPersonalidade: ${p.persona_description}` : "";
  // Greeting e farewell SAEM do system prompt. Eles são controlados EXCLUSIVAMENTE
  // pelo runtime context (buildRuntimeContext), que conhece o turnNumber e decide
  // se deve ou não injetar a saudação. Manter greeting aqui causava a IA a
  // reproduzi-lo em turnos posteriores mesmo com regra de "não repetir".
  const farewell = p?.farewell_style ? `\nAo encerrar conversa: "${p.farewell_style}"` : "";

  let langInst: string;
  if (p?.language === "en-US") {
    langInst = "\nResponda sempre em ingles.";
  } else if (p?.language === "es") {
    langInst = "\nResponda sempre em espanhol.";
  } else {
    langInst = "\nResponda em portugues. Se o lead escrever em ingles, responda em ingles. Adapte-se ao idioma do lead.";
  }

  return `## IDENTIDADE
${identity}
Canal: mensagem de texto (SMS/WhatsApp). Mensagens curtas.${persona}${farewell}${langInst}`;
}

function buildObjectiveSection(ctx: PromptContext): string {
  const isRecruitment = ctx.agentType === "recruitment_agent";

  const flexNote = !isRecruitment ? `
Se durante a conversa o lead demonstrar que já está pronto para agendar (mesmo antes de coletar todos os dados), adapte-se e proponha horários.` : "";

  const goldenRule = isRecruitment ? `

REGRA DE OURO (PRIORIDADE MAXIMA):
Quando o lead demonstrar QUALQUER sinal de interesse ou aceite ("sim", "quero", "pode ser", "claro", "ta bom", "ok", "topas", "vamos", "quero saber mais", "me interessei"):
→ PARE IMEDIATAMENTE de fazer perguntas de qualificacao
→ Va direto para o agendamento
→ Nao mande explicacoes, nao mande resumo, nao faca mais perguntas
→ Inclua a action book_appointment
Esta regra tem PRIORIDADE sobre a coleta de dados. Mesmo que faltem campos, AGENDE.` : "";

  switch (ctx.config.objective) {
    case "qualification_only":
      return `## OBJETIVO
Qualificar o lead coletando as informacoes listadas abaixo.
NAO tente agendar. Apos coletar tudo, defina conversation_status = "qualified".${goldenRule}${flexNote}`;

    case "qualification_and_booking":
      return `## OBJETIVO
1. Qualificar o lead coletando as informacoes listadas abaixo
2. Apos coletar os dados OBRIGATORIOS, agendar reuniao/ligacao
${isRecruitment ? "Voce precisa de NO MAXIMO 3 informacoes antes de convidar pro agendamento: estado, o que a pessoa faz, e um gancho/motivacao. Isso e TUDO. Nao aprofunde mais." : "Primeiro colete, depois agende."} Ao agendar com sucesso, defina conversation_status = "booked".${goldenRule}${flexNote}`;

    case "booking_only":
      return `## OBJETIVO
Agendar reuniao/ligacao com o lead. Pule qualificacao.
Ao agendar com sucesso, defina conversation_status = "booked".${goldenRule}${flexNote}`;

    default:
      return "";
  }
}

function buildRecruitmentSection(ctx: PromptContext): string {
  if (ctx.agentType !== "recruitment_agent") return "";

  const hasSpecialist = !!ctx.config.specialist_name;
  const specialist = hasSpecialist ? sanitize(ctx.config.specialist_name!, 50) : "";
  const role = sanitize(ctx.config.specialist_role || "especialista", 50);

  // Inferência de gênero (quando há nome). Se não houver, usa termos neutros.
  const nameLower = specialist.toLowerCase();
  const isFemale = hasSpecialist && (
    nameLower.endsWith("a") || nameLower.endsWith("ane") || nameLower.endsWith("ene") ||
    ["taciana", "juliana", "ana", "maria", "fernanda", "patricia", "camila", "larissa", "beatriz", "carol"].some(n => nameLower.includes(n))
  );
  const pronoun = hasSpecialist ? (isFemale ? "ela" : "ele") : "o especialista";
  const article = hasSpecialist ? (isFemale ? "a" : "o") : "o";
  const articleCap = hasSpecialist ? (isFemale ? "A" : "O") : "O";
  const specialistRef = hasSpecialist ? `${article} ${specialist}` : `o ${role}`;
  const specialistRefCap = hasSpecialist ? `${articleCap} ${specialist}` : `O ${role}`;

  const specialistBlock = hasSpecialist
    ? `ESPECIALISTA: ${specialist} (${role}) — genero: ${isFemale ? "feminino" : "masculino"}
Quando agendar, diga: "Deixa eu ver aqui na agenda d${article} ${specialist} quais horarios ${pronoun} tem disponivel..."
Sempre use "${article} ${specialist}" e "${pronoun}" (NUNCA "o(a)" ou "ele(a)").`
    : `ESPECIALISTA: (não configurado pelo admin) — use "o ${role}" de forma neutra.
Quando agendar, diga: "Deixa eu ver aqui na agenda do ${role} quais horarios ele tem disponivel..."`;

  const timeSlotRule = ctx.config.preferred_time_slot === "afternoon_evening"
    ? `- Ofereça APENAS horarios de TARDE ou NOITE por padrao
- Nunca ofereça horario de manha por iniciativa propria
- Excecao: se o candidato pedir explicitamente horario de manha, pode oferecer`
    : "- Ofereça horarios de qualquer periodo";

  const legalCheck = ctx.config.check_legal_docs
    ? `
VERIFICACAO LEGAL (APENAS para candidatos nos EUA):
- Se o candidato mora nos EUA, pergunte de forma natural: "So pra eu entender melhor... vc tem social security e permissao de trabalho nos EUA, ne?"
- Se o candidato mora no BRASIL ou outro pais: NAO pergunte sobre social security
- Se cidadao americano: nao pergunte sobre social/permissao
- Se SIM: continue normalmente
- Se NAO: "Entendi. Pra essa oportunidade e necessario ter a documentacao em dia. Mas se isso mudar no futuro, pode me chamar por aqui." Defina conversation_status = "disqualified".`
    : "";

  return `## REGRAS DE RECRUTAMENTO

${specialistBlock}

COMO DESCREVER A OPORTUNIDADE (quando perguntarem):
- Enquadre sempre como OPORTUNIDADE PROFISSIONAL / desenvolvimento de carreira, nunca como venda.
- Se perguntarem "voces vendem seguro?": reframe como oportunidade profissional na area de protecao financeira.
- Se pedirem mais detalhes: "${specialistRefCap} consegue te explicar muito melhor numa conversa rapida"
- Nunca transforme a conversa em apresentacao do produto.
- Nunca fale valores de comissao, custos de licenca ou estrutura de remuneracao.
- "Quanto vou ganhar?" → "Essa parte ${specialistRef} vai te explicar, depende de alguns fatores"
- "Quanto custa?" → "Existe um processo inicial com licencas, mas ${specialistRef} te explica direitinho"

PREFERENCIA DE HORARIO:
${timeSlotRule}
- Sempre ofereça exatamente 2 opcoes
- Formato: "[dia] as [hora] da tarde ou [dia] as [hora] da noite. Qual funciona melhor pra vc?"

OBJECOES DE RECRUTAMENTO:
- "Nao tenho experiencia" → "E nem precisa ter. Muita gente comeca do zero"
- "Nao tenho tempo" → "Entendo. E rapido, uns 20 minutos. ${specialistRefCap} vai direto pro que faz sentido pro seu caso"
- "Preciso pensar" → "Claro. Mas a conversa serve exatamente pra vc ter informacao suficiente pra pensar com clareza"
- "Tenho medo" → "Por isso a conversa ajuda. Vc entende o suporte e o processo antes de decidir qualquer coisa"
- "E golpe/piramide?" → "Entendo sua preocupacao. ${specialistRefCap} pode te mostrar tudo na conversa"
${legalCheck}`;
}

function buildToneSection(ctx: PromptContext): string {
  const profile = composePersonalityProfile({
    tone_creativity: ctx.config.tone_creativity,
    tone_formality: ctx.config.tone_formality,
    tone_naturalness: ctx.config.tone_naturalness,
    tone_aggressiveness: ctx.config.tone_aggressiveness,
  });

  const isNonDefault = (pct: number) => pct < 35 || pct > 65;
  const blocks: string[] = [];

  if (isNonDefault(ctx.config.tone_creativity)) {
    blocks.push(`Criatividade ${profile.creativity.percent}%: ${profile.creativity.directives}`);
  }
  if (isNonDefault(ctx.config.tone_formality)) {
    blocks.push(`Formalidade ${profile.formality.percent}%: ${profile.formality.directives}`);
  }
  if (isNonDefault(ctx.config.tone_naturalness)) {
    blocks.push(`Naturalidade ${profile.naturalness.percent}%: ${profile.naturalness.directives}`);
  }
  if (isNonDefault(ctx.config.tone_aggressiveness)) {
    blocks.push(`Agressividade ${profile.aggressiveness.percent}%: ${profile.aggressiveness.directives}`);
  }

  if (blocks.length === 0) return "";

  // Nota de prioridade quando o tom é extremo (0-19 ou 80-100) — essas
  // configurações foram escolhidas explicitamente pelo admin e devem
  // SOBREPOR o comportamento padrão em regras conflitantes.
  const agg = ctx.config.tone_aggressiveness ?? 50;
  const extremeNote = (agg >= 80 || agg < 20)
    ? `\n\n⚡ As diretivas de AGRESSIVIDADE acima têm PRIORIDADE SOBRE qualquer regra padrão que diga "encerre educadamente" ou "aceite recusa". O admin escolheu este tom explicitamente, você DEVE seguir as diretivas.`
    : "";

  return `## TOM DE VOZ
${blocks.join("\n\n")}${extremeNote}

Regra: máximo 1 pergunta por mensagem
- Nao repita perguntas ja respondidas`;
}

/**
 * Template ESTÁVEL dos campos a coletar — apenas definições (key, label,
 * required). Valores atuais ficam em buildRuntimeContext.
 */
function buildDataFieldsTemplateSection(ctx: PromptContext): string {
  if (ctx.config.data_fields.length === 0) return "";

  const fieldDefs = ctx.config.data_fields.map((field: DataField) => {
    const req = field.required ? "OBRIGATORIO" : "opcional";
    // Tipo inclui instrução inline de COMO perguntar/salvar.
    let typeHint: string;
    switch (field.type) {
      case "boolean":
        typeHint = 'tipo: SIM/NÃO (pergunta fechada — salve "sim" ou "não" no collected_data)';
        break;
      case "date":
        typeHint = "tipo: DATA (pergunte naturalmente, salve no formato que o lead usar)";
        break;
      case "select": {
        const opts = field.options && field.options.length > 0
          ? ` opções: [${field.options.slice(0, 10).map((o) => `"${o}"`).join(", ")}]`
          : "";
        typeHint = `tipo: ESCOLHA (${opts ? "uma das opções abaixo — salve EXATAMENTE uma delas)" : "lista de opções)"}${opts}`;
        break;
      }
      case "text":
      default:
        typeHint = "tipo: TEXTO (pergunta aberta)";
        break;
    }
    return `- key: "${field.key}" | label: "${field.label}" | ${req} | ${typeHint}`;
  });

  // Conta se há boolean/select pra injetar regras específicas
  const hasBoolean = ctx.config.data_fields.some((f) => f.type === "boolean");
  const hasSelect = ctx.config.data_fields.some((f) => f.type === "select");

  const typeRules: string[] = [];
  if (hasBoolean) {
    typeRules.push(
      `- Campos tipo SIM/NÃO: faça pergunta FECHADA (ex: "Você tem Social Security?" em vez de "Qual seu Social Security?"). Salve "sim" ou "não" em collected_data.`,
    );
  }
  if (hasSelect) {
    typeRules.push(
      `- Campos tipo ESCOLHA: apresente as opções e peça pra escolher. Salve EXATAMENTE uma das opções listadas (não variações).`,
    );
  }

  return `## DADOS PARA COLETAR (colete de forma NATURAL, dentro da conversa)
${fieldDefs.join("\n")}

COMO COLETAR:
- Conduza a conversa de forma natural seguindo as instruções do administrador acima
- NAO faca perguntas roboticas tipo "Qual seu nome completo?", integre na conversa
- Se o lead mencionar dados espontaneamente, EXTRAIA e salve no collected_data
- Se o lead responder varios dados de uma vez, extraia TODOS
- Campos já preenchidos (ver CONTEXTO ATUAL na user message) nao devem ser perguntados
- Se ja perguntou 2 vezes por um campo e o lead ignorou, PULE e siga em frente
- Se o lead demonstrar aceite ("sim", "topo", "quero"), AGENDE mesmo com campos faltantes
- RESPEITE o tipo de cada campo (ver "tipo:" na listagem acima).${typeRules.length > 0 ? "\n" + typeRules.join("\n") : ""}

KEYS do collected_data (usar EXATAMENTE):
${ctx.config.data_fields.map((f) => `"${f.key}"`).join(", ")}`;
}

function buildMediaInstructionsSection(config: AgentConfig): string {
  const parts: string[] = [];

  if (config.enable_audio_transcription) {
    parts.push(`Quando o lead enviar um AUDIO:
- A transcricao aparece na mensagem automaticamente
- Use o conteudo para dar continuidade a conversa de forma natural
- NAO diga "recebi seu audio" de forma robotica — reaja como humano`);
  }

  if (config.enable_image_analysis) {
    parts.push(`Quando o lead enviar uma IMAGEM:
- Descreva brevemente o que voce ve, de forma natural e contextual
- Use a imagem para dar continuidade a conversa (ex: se e um curriculo, documento, produto, localizacao)
- NAO diga "recebi sua imagem" de forma robotica — reaja como humano`);
  }

  if (config.enable_pdf_reading) {
    parts.push(`Quando o lead enviar um DOCUMENTO (PDF, DOC):
- O conteudo extraido aparece na mensagem como [Documento "nome"]: texto...
- Use o conteudo para responder perguntas — NAO repita o texto inteiro
- Se o documento for relevante para a qualificacao, extraia dados e salve no collected_data`);
  }

  if (parts.length === 0) return "";

  return `## MIDIA RECEBIDA\n${parts.join("\n\n")}\n\nSe receber midia que nao pode ser processada, diga de forma natural: "Nao consegui abrir esse arquivo. Pode mandar como PDF ou foto?"`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildConversationRulesSection(ctx: PromptContext): string {
  const agg = ctx.config.tone_aggressiveness ?? 50;
  const isAggressive = agg >= 80;   // ultra_high
  const isProactive = agg >= 60 && agg < 80;  // high
  const isPassive = agg < 20;       // ultra_low

  // Regras de "parada/aceite" variam conforme o tom de agressividade.
  // Em modo agressivo, a IA DEVE rebater antes de aceitar recusa.
  let situacoesBlock: string;
  if (isAggressive) {
    situacoesBlock = `SITUAÇÕES ESPECIAIS (tom AGRESSIVO — ${agg}%):
- "depois" / "to ocupado" → NÃO encerre. Rebata com argumento ("por isso mesmo é rápido, 10 min", "consigo te ajudar agora em 2 minutos")
- "não quero" / "não tenho interesse" → NÃO aceite na 1ª. Rebata com argumento DIFERENTE cada tentativa (benefício concreto, escassez, FOMO, prova social)
- Insista até 3x com argumentos DIFERENTES antes de aceitar. Só aceite após 3 recusas reais ou "para de me mandar mensagem"
- Lead volta depois → retome com urgência
- Pede humano → status = "handed_off"
- "para de mandar" / "me deixa em paz" (explícito) → status = "disqualified", encerre com respeito
- Mensagem incompreensível → peça para repetir de forma natural`;
  } else if (isProactive) {
    situacoesBlock = `SITUAÇÕES ESPECIAIS (tom PROATIVO — ${agg}%):
- "depois" / "to ocupado" → tente 1 argumento leve antes de aceitar ("é rapidinho, 5 min")
- "não quero" (1ª vez) → rebata UMA vez com benefício. Na 2ª recusa, aceite e deixe porta aberta
- Máximo de 2 insistências por conversa
- Lead volta depois → retome de onde parou
- Pede humano → status = "handed_off"
- "para de mandar" (2ª vez explícita) → status = "disqualified"
- Mensagem incompreensível → peça para repetir de forma natural`;
  } else if (isPassive) {
    situacoesBlock = `SITUAÇÕES ESPECIAIS (tom PASSIVO — ${agg}%):
- "depois" / "to ocupado" / "não quero" → ACEITE IMEDIATAMENTE sem insistir, status = "stale" ou "disqualified"
- NUNCA insista nem rebata objeção
- Lead volta depois → retome de onde parou
- Pede humano → status = "handed_off"
- Mensagem incompreensível → peça para repetir de forma natural`;
  } else {
    situacoesBlock = `SITUAÇÕES ESPECIAIS:
- "depois" / "to ocupado" → encerre educadamente, status = "stale"
- Lead volta depois → retome de onde parou
- Pede humano → status = "handed_off"
- "não quero" / "cancela" (2ª vez) → status = "disqualified"
- Mensagem incompreensível → peça para repetir de forma natural
- Nunca insista mais que 2x na mesma pergunta`;
  }

  return `## REGRAS DE CONVERSA

CONTINUIDADE:
- Leia o histórico ANTES de responder, nunca repita cumprimento ou pergunta já feita
- Se já se apresentou, vá direto ao ponto na próxima mensagem
- Cada mensagem deve AVANÇAR a conversa

${situacoesBlock}`;
}

/**
 * Offset UTC ATUAL de uma timezone IANA no formato "+HH:MM"/"-HH:MM".
 * Usa Intl (longOffset) → resolve DST automaticamente (C2-P2d). Fallback -05:00.
 */
function currentTzOffset(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return "-05:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${m[3] || "00"}`;
  } catch {
    return "-05:00";
  }
}

/**
 * Template ESTÁVEL de agendamento — apenas fluxo e regras de timezone.
 * Horários disponíveis e "agora" ficam em buildRuntimeContext.
 */
function buildBookingSection(ctx: PromptContext): string {
  if (ctx.config.objective === "qualification_only") return "";

  const tzConfig = ctx.config.timezone_config;
  let effectiveTimezone = ctx.timezone;
  let tzLabel = "ET";

  if (tzConfig && !tzConfig.use_location_default && tzConfig.custom_timezone) {
    effectiveTimezone = tzConfig.custom_timezone;
  }

  if (effectiveTimezone.includes("New_York")) tzLabel = "ET";
  else if (effectiveTimezone.includes("Chicago")) tzLabel = "CT";
  else if (effectiveTimezone.includes("Denver")) tzLabel = "MT";
  else if (effectiveTimezone.includes("Los_Angeles")) tzLabel = "PT";

  // C2-P2d (ultra-review 2026-05-26): offset computado dinamicamente (lida com
  // DST + cobre tz não-US). Antes era hardcoded no horário de VERÃO (ET=-04:00),
  // ficando 1h errado no inverno — e o book_appointment usa esse offset no
  // start_time, então o agendamento saía 1h torto metade do ano.
  const tzOffset = currentTzOffset(effectiveTimezone);

  return `## AGENDAMENTO
Timezone padrão: ${tzLabel} (${effectiveTimezone})

REGRA DE TIMEZONE:
- Presuma que o lead esta no ${tzLabel}. NAO pergunte o timezone — mencione naturalmente (ex: "2 PM ${tzLabel}")
- Se o lead corrigir o timezone, ajuste
- start_time DEVE usar offset ${tzOffset}

FLUXO DE AGENDAMENTO (rapido e fluido):
- Quando todos os dados estiverem coletados, proponha 2 horarios da lista NA MESMA MENSAGEM
- Consulte "HORÁRIOS DISPONÍVEIS" no CONTEXTO ATUAL (user message) para os slots reais
- IMPORTANTE: se essa seção NÃO existir OU se "AGENDA AINDA NÃO CONSULTADA" aparecer, NÃO mencione horários específicos — peça intervalo (dia + turno) e diga que vai verificar
- Exemplo COM lista disponível: "Tenho horario amanha as 11 AM ou 2 PM ${tzLabel}, qual vc prefere?" (horários reais da seção)
- Exemplo SEM lista disponível: "Qual dia e turno (manhã/tarde) funciona melhor pra vc? Deixa eu confirmar a agenda e te volto com horários."
- NAO faca perguntas extras antes de propor (timezone, disponibilidade, etc)
- Se o lead escolher um horario, agende IMEDIATAMENTE com a action book_appointment
- Se o horario pedido nao esta disponivel, diga e proponha os mais proximos da lista
- NUNCA invente horarios que nao estao na lista

${buildPostBookingInstructions(ctx)}

${buildRescheduleInstructions(ctx)}`;
}

function buildPostBookingInstructions(ctx: PromptContext): string {
  const pb = ctx.config.post_booking;
  if (!pb) return "";

  if (pb.behavior === "stop_and_handoff") {
    return `APOS AGENDAR COM SUCESSO:
- Confirme o agendamento
- Envie: "${pb.handoff_message || "Obrigado! Um membro da equipe entrara em contato."}"
- Defina conversation_status = "booked"
- NAO continue a conversa`;
  }

  return `APOS AGENDAR COM SUCESSO:
- Confirme o agendamento e continue disponivel para duvidas
- Defina conversation_status = "booked"
- Responda duvidas ate o horario do agendamento`;
}

function buildRescheduleInstructions(ctx: PromptContext): string {
  if (!ctx.config.post_booking?.allow_reschedule) return "";

  const calendarId = ctx.config.calendar_id || "";

  return `REAGENDAMENTO:
- Se o lead pedir para mudar horario, use action "reschedule_appointment"
- SEMPRE inclua calendar_id: "${calendarId}"
- Proponha opcoes da lista de horarios disponiveis
- Exemplo: { "type": "reschedule_appointment", "calendar_id": "${calendarId}", "start_time": "2026-04-09T15:00:00-04:00" }`;
}

function buildFeedbackSection(ctx: PromptContext): string {
  if (!ctx.feedback || ctx.feedback.length === 0) return "";

  const positives = ctx.feedback.filter((f) => f.rating === "positive");
  const negatives = ctx.feedback.filter((f) => f.rating === "negative");

  let section = "## APRENDIZADOS DO FEEDBACK\n";

  if (positives.length > 0) {
    section += "\nEstilo aprovado:\n";
    for (const f of positives.slice(0, 3)) {
      section += `- ✓ "${sanitize(f.ai_message, 120)}"\n`;
    }
  }

  if (negatives.length > 0) {
    section += "\nEvitar:\n";
    for (const f of negatives.slice(0, 5)) {
      section += `- ✗ "${sanitize(f.ai_message, 120)}"`;
      if (f.suggestion) {
        section += ` → melhor: "${sanitize(f.suggestion, 120)}"`;
      }
      section += "\n";
    }
  }

  return section;
}

function buildKnowledgeBaseSection(ctx: PromptContext): string {
  const generalInstructions = (ctx.config.knowledge_base_instructions || "").trim();
  if ((!ctx.knowledgeBase || ctx.knowledgeBase.length === 0) && !generalInstructions) return "";

  const GLOBAL_CAP = 12000;
  const PER_ITEM_CAP = 4000;

  let remaining = GLOBAL_CAP;
  const renderedItems: string[] = [];
  const kbItems = ctx.knowledgeBase || [];

  for (let i = 0; i < kbItems.length; i++) {
    if (remaining <= 0) {
      renderedItems.push(`[... ${kbItems.length - i} item(ns) adicionais omitido(s) por limite de contexto]`);
      break;
    }

    const item = kbItems[i];
    const title = sanitize(item.title || "Sem titulo", 100);

    let typeLabel: string;
    let sourceLabel = "";
    if (item.type === "file") {
      typeLabel = "arquivo";
      if (item.file_name) sourceLabel = ` | Fonte: ${sanitize(item.file_name, 120)}`;
    } else if (item.type === "url") {
      typeLabel = "url";
      if (item.file_url) sourceLabel = ` | Fonte: ${sanitize(item.file_url, 200)}`;
    } else {
      typeLabel = "texto";
    }

    const itemCap = Math.min(PER_ITEM_CAP, remaining);
    let content = (item.content || "").trim();
    let truncated = false;
    if (content.length > itemCap) {
      content = content.substring(0, itemCap);
      truncated = true;
    }
    remaining -= content.length;

    const header = `[ITEM ${i + 1}] Tipo: ${typeLabel} | Titulo: "${title}"${sourceLabel}`;
    const descLine = item.description ? `Descricao: ${sanitize(item.description, 500)}` : "";
    const usageLine = item.usage_instructions
      ? `Como usar: ${sanitize(item.usage_instructions, 800)}`
      : "";
    const meta = [descLine, usageLine].filter(Boolean).join("\n");
    const body = content || "(vazio)";
    const suffix = truncated ? "\n[...conteudo truncado]" : "";
    renderedItems.push(`${header}${meta ? "\n" + meta : ""}\nConteudo:\n${body}${suffix}`);
  }

  const generalBlock = generalInstructions
    ? `\n### INSTRUCOES GERAIS DA BASE (definidas pelo administrador)\n${sanitize(generalInstructions, 4000)}\n`
    : "";

  const itemsBlock = renderedItems.length > 0
    ? `\n### ITENS DA BASE\n\n${renderedItems.join("\n\n")}`
    : "\n(Nenhum item cadastrado — siga as instrucoes gerais acima)";

  return `## BASE DE CONHECIMENTO

Use estas informações como referência. Se o lead perguntar algo coberto aqui, responda com base neste conteúdo. Se não souber, diga que vai confirmar com a equipe. Nunca mencione que tem uma "base" ou "documento" — use naturalmente.
${generalBlock}${itemsBlock}`;
}

// F31 (Pedro 2026-05-28): caps alinhados com builder-spec.ts (max 8000) e
// validation.ts (idem 8000). Antes: zod permitia 10k mas builder cortava
// em 3k — silent loss. Subi pra 8000 (~2k tokens) tolerável no contexto
// total do prompt (~10-15k tokens).
const CUSTOM_INSTRUCTIONS_CAP = 8000;
const CONVERSATION_EXAMPLES_CAP = 8000;

function buildCustomInstructionsSection(ctx: PromptContext): string {
  if (!ctx.config.custom_instructions) return "";
  const raw = ctx.config.custom_instructions;
  if (raw.length > CUSTOM_INSTRUCTIONS_CAP) {
    console.warn(
      `[prompt] custom_instructions truncado de ${raw.length} → ${CUSTOM_INSTRUCTIONS_CAP} chars`,
    );
  }
  let instructions = raw.substring(0, CUSTOM_INSTRUCTIONS_CAP);
  // Se contactName estiver vazio, substitui {contact.name} por "o lead" em
  // vez de deixar "Olá , vamos conversar?" (vírgula solta) ou pior, o placeholder
  // literal "{contact.name}" aparecer no output.
  const contactNameSafe = ctx.contactName?.trim() || "o lead";
  instructions = instructions
    .replace(/\{contact\.name\}/g, contactNameSafe)
    .replace(/\{agent\.name\}/g, ctx.config.personality?.name || "Agente")
    .replace(/\{location\.name\}/g, ctx.locationName)
    .replace(/\{agent\.specialist\}/g, ctx.config.specialist_name || "especialista");
  return `## INSTRUÇÕES DO ADMINISTRADOR (seguir com PRIORIDADE)
${instructions}`;
}

/**
 * F37 (Pedro 2026-05-29): seção de histórico do lead carregado do Spark Leads.
 * Se `ctx.leadHistory` veio (config.lead_history_config.enabled=true), monta
 * resumo compacto: tags + funil/stage + últimas msgs + notas. Vazio se
 * não veio ou se histórico está vazio (lead totalmente novo).
 */
export function buildLeadHistorySection(ctx: PromptContext): string {
  const h = ctx.leadHistory;
  if (!h || (h.recent_messages.length === 0 && h.opportunities.length === 0 && h.notes.length === 0 && h.contact.tags.length === 0)) {
    return "";
  }
  const lines: string[] = ["## HISTÓRICO ANTERIOR DESSE LEAD (do Spark Leads)"];
  lines.push("");
  lines.push("USE este contexto pra responder coerente. NÃO pergunte coisas já respondidas. Reconheça continuidade — esse contato pode já ter conversado com humanos ou ter histórico.");
  lines.push("");

  // Defense-in-depth 2026-06-10: sanitize() em todo campo controlável pelo lead
  // (tags, nomes de opp/stage, corpo de msg/nota) — mesma proteção anti-injection
  // das seções buildFeedbackSection/buildKnowledgeBaseSection. O inbound já chega
  // cru ao LLM como user-role; isto só fecha o gap de consistência no system prompt.
  // Truthiness dos condicionais segue no valor BRUTO pra manter comportamento igual.
  if (h.contact.tags.length > 0) {
    lines.push(`**Tags do contato**: ${h.contact.tags.map((t) => sanitize(t, 60)).join(", ")}`);
  }
  if (h.opportunities.length > 0) {
    lines.push("**Oportunidades**:");
    for (const o of h.opportunities) {
      const stage = o.pipelineName && o.stageName
        ? `${sanitize(o.pipelineName, 80)} → ${sanitize(o.stageName, 80)}`
        : (o.stageName ? sanitize(o.stageName, 80) : "(stage desconhecido)");
      const value = o.monetaryValue ? ` ($${o.monetaryValue})` : "";
      const status = o.status ? ` [${o.status}]` : "";
      lines.push(`  - ${o.name ? sanitize(o.name, 80) : "(sem nome)"} — ${stage}${status}${value}`);
    }
  }
  if (h.recent_messages.length > 0) {
    lines.push("");
    lines.push(`**Últimas ${Math.min(h.recent_messages.length, 10)} mensagens** (mais recente em cima):`);
    for (const m of h.recent_messages.slice(0, 10)) {
      // Rótulo humano×bot via fonte ÚNICA (@/lib/ghl/message-sources): mesma
      // lógica do should-respond gate. Fix 2026-06-10: o check antigo
      // `source !== "api"` rotulava o welcome de automação (source
      // "workflow"/"campaign") como "Humano (rep)" — soft nudge que fazia o
      // modelo assumir que um humano já estava atendendo o lead.
      const who = m.direction === "inbound" ? "Lead" : (isHumanOutboundSource(m.source) ? "Humano (rep)" : "Bot/sistema");
      const date = m.dateAdded ? new Date(m.dateAdded).toISOString().slice(0, 16) : "";
      // m.body já vem cortado em 300 (lead-history.ts:249); sanitize tira #/quebras.
      lines.push(`  [${date}] ${who}: "${sanitize(m.body, 300)}"`);
    }
  }
  if (h.notes.length > 0) {
    lines.push("");
    lines.push("**Notas internas** (não compartilhar literalmente com o lead):");
    for (const n of h.notes.slice(0, 5)) {
      const date = n.dateAdded ? new Date(n.dateAdded).toISOString().slice(0, 10) : "";
      lines.push(`  - [${date}] ${sanitize(n.body, 300)}`);
    }
  }
  return lines.join("\n");
}

function buildExamplesSection(ctx: PromptContext): string {
  if (!ctx.config.conversation_examples) return "";
  const raw = ctx.config.conversation_examples;
  if (raw.length > CONVERSATION_EXAMPLES_CAP) {
    console.warn(
      `[prompt] conversation_examples truncado de ${raw.length} → ${CONVERSATION_EXAMPLES_CAP} chars`,
    );
  }
  return `## EXEMPLOS DE CONVERSA IDEAL
Os exemplos abaixo mostram o tom e fluxo desejado pelo administrador:

${raw.substring(0, CONVERSATION_EXAMPLES_CAP)}`;
}

function buildResponseFormatSection(ctx: PromptContext): string {
  const exampleKeys = ctx.config.data_fields.slice(0, 3).map((f) => `"${f.key}": "valor"`).join(", ");

  return `## FORMATO DE RESPOSTA (OBRIGATORIO)
Responda APENAS JSON valido, sem markdown:

{
  "message": "sua resposta aqui (NUNCA vazio)",
  "should_send_message": true,
  "actions": [],
  "collected_data": { ${exampleKeys} },
  "conversation_status": "active"
}

REGRAS DO JSON:
1. "message": OBRIGATORIO, NUNCA vazio. String ou array de strings. Use array para dividir em multiplas mensagens
2. "should_send_message": SEMPRE true. Voce SEMPRE responde ao lead, sem excecao
3. "actions": array de acoes. Inclua APENAS acoes NOVAS (nao repita acoes de turnos anteriores)
4. "collected_data": TODOS os dados coletados ate agora (cumulativo). Use EXATAMENTE as keys dos campos: ${ctx.config.data_fields.map((f) => `"${f.key}"`).join(", ")}
5. "conversation_status": use "active" (em andamento), "qualified" (todos dados coletados), "booked" (agendamento feito), "stale" (lead sumiu/adiou), "handed_off" (pediu humano), "disqualified" (nao quer mais)

REGRA CRITICA sobre "booked" (F24 fix Pedro 2026-05-28):
- Use "booked" SOMENTE quando voce ja incluiu action "book_appointment" NESTE turno OU em turno anterior E o agendamento foi confirmado.
- Nao use "booked" quando: voce ainda esta perguntando dia/turno; voce esta PROPONDO horarios mas o lead nao escolheu; voce mencionou agendamento mas nao executou a action.
- Em duvida, mantenha "active". KPI inflado por "booked" prematuro afeta decisoes de negocio.

NUNCA retorne texto fora do JSON.`;
}

/**
 * Schema JSON dinâmico para Structured Outputs da OpenAI. Força o modelo a
 * retornar exatamente a estrutura esperada — elimina fallbacks por JSON inválido.
 * strict: true requer additionalProperties: false e required com todas as chaves.
 */
export function buildResponseJsonSchema(ctx: PromptContext) {
  const fieldKeys = ctx.config.data_fields.map((f) => f.key);

  const collectedDataProps: Record<string, { type: string[] }> = {};
  for (const key of fieldKeys) {
    collectedDataProps[key] = { type: ["string", "null"] };
  }

  return {
    name: "agent_response",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["message", "should_send_message", "actions", "collected_data", "conversation_status"],
      properties: {
        message: { type: "string", description: "Resposta ao lead. Nunca vazio." },
        should_send_message: { type: "boolean" },
        actions: {
          type: "array",
          // H4 (review 2026-04-28): antes deste fix, o schema tinha um único
          // `properties` com 10 campos TODOS required (`field_key`, `value`,
          // `tag`, `calendar_id`, `start_time`, `appointment_id`, `title`,
          // `pipeline_id`, `stage_id`). Em modo strict, modelo gerava 10
          // keys com null em CADA action — 20-30% desperdício de output
          // tokens. Agora discriminamos por `type` via anyOf — cada variante
          // marca apenas seus campos como required.
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["type"],
                properties: {
                  type: { type: "string", enum: ["send_message"] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "field_key", "value"],
                properties: {
                  type: { type: "string", enum: ["update_field"] },
                  field_key: { type: "string" },
                  value: { type: "string" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "tag"],
                properties: {
                  type: { type: "string", enum: ["add_tag", "remove_tag"] },
                  tag: { type: "string" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                // Fix bug observado em prod 2026-05-05: OpenAI strict mode
                // exige que `required` inclua TODAS as keys de `properties`.
                // Antes title era opcional mas listado em properties → 400
                // "Invalid schema for response_format ... Missing 'title'".
                // Agora title é obrigatório mas nullable — LLM passa null se
                // não quiser título customizado.
                required: ["type", "calendar_id", "start_time", "title"],
                properties: {
                  type: { type: "string", enum: ["book_appointment"] },
                  calendar_id: { type: "string" },
                  start_time: { type: "string", description: "ISO 8601 com offset" },
                  title: { type: ["string", "null"] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                // Fix HIGH-8 (deep review 2026-05-05): appointment_id é
                // nullable porque LLM nem sempre tem ID real (vai depender
                // de findExistingAppointment lookup). Antes strict mode
                // forçava string → LLM alucinava ID inválido → 404 GHL.
                required: ["type", "appointment_id", "start_time"],
                properties: {
                  type: { type: "string", enum: ["reschedule_appointment"] },
                  appointment_id: { type: ["string", "null"] },
                  start_time: { type: "string", description: "ISO 8601 com offset" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "pipeline_id", "stage_id"],
                properties: {
                  type: { type: "string", enum: ["move_pipeline"] },
                  pipeline_id: { type: "string" },
                  stage_id: { type: "string" },
                },
              },
            ],
          },
        },
        collected_data: {
          type: "object",
          additionalProperties: false,
          required: fieldKeys,
          properties: collectedDataProps,
        },
        conversation_status: {
          type: "string",
          enum: ["active", "qualified", "booked", "stale", "handed_off", "disqualified"],
        },
      },
    },
  };
}

// ============================================================
// FOLLOW-UP PROMPT
// ============================================================

interface FollowUpPromptContext {
  config: AgentConfig;
  agentType?: "sales_agent" | "recruitment_agent" | "custom_agent";
  attemptNumber: number;
  locationName: string;
  currentDate: string;
  timezone: string;
  /**
   * Nome do contato (do GHL). Permite personalização do follow-up.
   */
  contactName?: string;
  /**
   * Dados já coletados da conversa anterior. Follow-up não deve pedir de novo.
   */
  collectedData?: Record<string, string>;
  /**
   * Resumo das últimas mensagens trocadas. Dá contexto pro follow-up saber
   * onde a conversa parou e referenciar de forma natural.
   */
  recentHistory?: string;
}

export function buildFollowUpPrompt(ctx: FollowUpPromptContext): string {
  const followUpConfig = ctx.config.follow_up_config;
  const customInstructions = followUpConfig?.custom_prompt
    ? `\n\nInstrucoes adicionais:\n${followUpConfig.custom_prompt}`
    : "";

  const isRecruitment = ctx.agentType === "recruitment_agent";
  const p = ctx.config.personality;
  const name = p?.name || "Assistente";
  const isHuman = p?.identity_mode === "human";

  // Fix bug observado em prod 2026-06-16: o ramo recruitment dizia "CLIENTE que
  // já comprou / pós-venda" — INVERTIDO pra um CANDIDATO frio de prospecção. Como
  // o custom_prompt é ADITIVO (não sobrescreve), a frase errada vazava no prompt
  // e contradizia o follow-up. Corrigido pra prospecção de recrutamento.
  const contextDesc = isRecruitment
    ? `Voce esta retomando contato com um CANDIDATO que demonstrou interesse na oportunidade de carreira (NAO e cliente, NAO comprou nada). E PROSPECCAO: reaqueca o interesse e conduza pra apresentacao, sem reapresentar do zero e sem requalificar o que ele ja respondeu.
${ctx.config.specialist_name ? `Se precisar escalar, mencione que ${ctx.config.specialist_name} pode ajudar.` : ""}`
    : "Voce esta retomando contato com um lead sobre um servico/produto.";

  const identityInst = isHuman
    ? `Voce e ${name}. NUNCA diga que e IA, bot ou assistente virtual.`
    : `Voce e ${name}, da equipe da ${ctx.locationName}.`;

  const contactBlock = ctx.contactName
    ? `\nNome do lead: ${sanitize(ctx.contactName, 80)}`
    : "";

  const collectedBlock = (() => {
    if (!ctx.collectedData) return "";
    const entries = Object.entries(ctx.collectedData).filter(([, v]) => v && String(v).trim());
    if (entries.length === 0) return "";
    const lines = entries.slice(0, 10).map(([k, v]) => `- ${k}: "${sanitize(String(v), 120)}"`).join("\n");
    return `\n\n## DADOS JÁ COLETADOS (NÃO pergunte de novo)\n${lines}`;
  })();

  const historyBlock = ctx.recentHistory
    ? `\n\n## ÚLTIMAS MENSAGENS (onde a conversa parou)\n${ctx.recentHistory.substring(0, 2000)}`
    : "";

  return `## IDENTIDADE
${identityInst}${contactBlock}
Data: ${ctx.currentDate} | Timezone: ${ctx.timezone}
Follow-up #${ctx.attemptNumber}.

============================================================
REGRAS ABSOLUTAS (VALEM SEMPRE, SEM EXCEÇÃO)
============================================================
- NÃO use travessão ("—" ou "–"). Use vírgula, ponto ou parênteses.
- NÃO use reticências longas ("..."). Prefira frase curta.
- Este é um follow-up — você JÁ conversou com esse lead antes. NÃO se
  apresente de novo ("oi, sou X, da empresa Y"). O lead já sabe quem
  você é. Retome o assunto específico onde pararam.
============================================================

## CONTEXTO
${contextDesc}${collectedBlock}${historyBlock}

## DECIDA PRIMEIRO: VALE A PENA MANDAR ESTE FOLLOW-UP AGORA?
Você é inteligente sobre isso — NÃO é um robô que cutuca sempre. Leia o CONTEXTO
acima e, se cair em QUALQUER caso abaixo, NÃO mande nada: retorne EXATAMENTE
"message": "[[NAO_ENVIAR]]" (esse marcador literal) e "conversation_status"
adequado. O sistema entende esse marcador como "ficar quieto". É melhor ficar
quieto que mandar um follow-up sem noção.
- O lead ADIOU pra uma data futura ("volto semana que vem", "mês que vem", "tô
  viajando", "tô no Brasil", "depois eu vejo", "ano que vem", "quando voltar eu
  falo"): NÃO pergunte se "já voltou" — ele te disse que ainda NÃO. Fique quieto
  agora ("message": "").
- O lead RECUSOU ou perdeu interesse ("não tenho interesse", "não quero", "não
  posso pagar", "agora não dá", "para de mandar"): NÃO insista. "message": "",
  "conversation_status": "disqualified".
- O lead pediu pra falar com humano: "message": "", "conversation_status": "handed_off".
- A ÚLTIMA mensagem da conversa foi SUA (AGENTE) e o lead ainda não respondeu:
  NÃO empilhe outra mensagem em cima da sua. Dê espaço. "message": "".
- A conversa já está agendada/fechada e não há o que retomar: "message": "".
SÓ mande follow-up quando o lead realmente sumiu no meio de uma conversa aberta,
sem ter adiado nem recusado.

## SE FOR MANDAR
- 1-2 frases, humana, sem parecer robo
- USE o contexto acima: chame o lead pelo nome (se souber) e referencie o ponto onde pararam
- Nao repita perguntas ja feitas nem peça dados ja coletados
- Nao mencione automacao, IA ou follow-up
- #1: lembrete leve ("oi fulano, ficou pendente o X que vc mencionou")
- #2-3: direto, retome o assunto especifico
- #4+: ultimo toque educado com opt-out suave
${customInstructions}

## FORMATO
JSON apenas:
{
  "message": "sua mensagem (ou \"[[NAO_ENVIAR]]\" pra NÃO mandar)",
  "should_send_message": true,
  "actions": [],
  "collected_data": {},
  "conversation_status": "active"
}

Se decidir mandar, "message" tem o texto do follow-up. Se decidir NÃO mandar
(qualquer caso da seção DECIDA acima), "message" é EXATAMENTE "[[NAO_ENVIAR]]" — o
sistema reconhece esse marcador e fica quieto (não manda nada pro lead).`;
}
