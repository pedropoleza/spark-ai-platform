import type { AgentConfig, DataField } from "@/types/agent";
import { getTimezoneFromState, getCurrentTimeInTimezone } from "@/lib/utils/timezone";
import { composePersonalityProfile } from "@/lib/ai/behavior-blocks";

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

interface PromptContext {
  config: AgentConfig;
  agentType?: "sales_agent" | "recruitment_agent";
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
    const dataContext = ctx.config.data_fields.length > 0 ? buildDataFieldsTemplateSection(ctx) : "";
    return [
      ctx.config.system_prompt_override,
      dataContext,
      buildResponseFormatSection(ctx),
    ].filter(Boolean).join("\n\n");
  }

  const sections = [
    buildMetaInstruction(),
    buildIdentitySection(ctx),
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

/**
 * Contexto VOLÁTIL — muda a cada turno. Injetado na user message, NUNCA no
 * system prompt, para preservar cache hit. Contém: data/hora atual, estado dos
 * dados coletados, horários disponíveis.
 */
export function buildRuntimeContext(ctx: PromptContext): string {
  const parts: string[] = [];

  const turnCount = ctx.priorTurnCount ?? 0;
  const isFirstTurn = turnCount === 0;

  // Sinal explícito sobre o estado da conversa. Evita que o modelo repita
  // saudação em turnos posteriores (bug comum na aba de testes onde histórico
  // em string é interpretado como exemplo e não como contexto real).
  const turnStateBlock = isFirstTurn
    ? `ESTADO: PRIMEIRA mensagem da conversa. Use a saudação inicial configurada.`
    : `ESTADO: TURNO ${turnCount + 1} da conversa (já houve ${turnCount} troca${turnCount > 1 ? "s" : ""}).
REGRA ABSOLUTA: VOCÊ JÁ SE APRESENTOU. NÃO repita saudação, nome próprio, nem "oi/olá/meu nome é". Vá direto ao ponto da mensagem do lead.`;

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
${ctx.availableSlots}`);
    }
  }

  return parts.join("\n\n");
}

function buildMetaInstruction(): string {
  return `## DIRETRIZ PRINCIPAL
Você é um conversador INTELIGENTE e NATURAL via WhatsApp/SMS.

PRIORIDADES (nesta ordem):
1. Siga as INSTRUÇÕES DO ADMINISTRADOR — elas definem o tom, fluxo e abordagem da conversa
2. Seja HUMANO e FLUIDO — nunca pareça formulário, robô ou script
3. AVANCE a conversa a cada mensagem — nunca repita, nunca estagne
4. Colete informações de forma NATURAL dentro da conversa, não como interrogatório
5. Quando o lead demonstrar interesse, AGENDE — não prolongue desnecessariamente`;
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
  // Greeting só é usado quando CONTEXTO ATUAL indica "PRIMEIRA mensagem".
  // Em qualquer outro turno, o runtime context impede a saudação explicitamente.
  const greeting = p?.greeting_style
    ? `\nSaudação inicial (USAR APENAS se CONTEXTO ATUAL indicar "PRIMEIRA mensagem"): "${p.greeting_style}"`
    : "";
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
Canal: mensagem de texto (SMS/WhatsApp). Mensagens curtas.${persona}${greeting}${farewell}${langInst}`;
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
  if (ctx.agentType !== "recruitment_agent" || !ctx.config.specialist_name) return "";

  const specialist = sanitize(ctx.config.specialist_name, 50);
  const role = sanitize(ctx.config.specialist_role || "especialista", 50);

  const nameLower = specialist.toLowerCase();
  const isFemale = nameLower.endsWith("a") || nameLower.endsWith("ane") || nameLower.endsWith("ene") ||
    ["taciana", "juliana", "ana", "maria", "fernanda", "patricia", "camila", "larissa", "beatriz", "carol"].some(n => nameLower.includes(n));
  const pronoun = isFemale ? "ela" : "ele";
  const article = isFemale ? "a" : "o";
  const articleCap = isFemale ? "A" : "O";

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

ESPECIALISTA: ${specialist} (${role}) — genero: ${isFemale ? "feminino" : "masculino"}
Quando agendar, diga: "Deixa eu ver aqui na agenda d${article} ${specialist} quais horarios ${pronoun} tem disponivel..."
Sempre use "${article} ${specialist}" e "${pronoun}" (NUNCA "o(a)" ou "ele(a)").

COMO DESCREVER A OPORTUNIDADE (quando perguntarem):
- "Basicamente, a gente ajuda familias brasileiras aqui nos EUA na parte de protecao financeira. E tambem desenvolve pessoas que querem crescer profissionalmente nessa area."
- Se perguntarem "voces vendem seguro?": reframe como "protecao financeira" e oportunidade de carreira
- Se pedirem mais detalhes: "${articleCap} ${specialist} consegue te explicar muito melhor numa conversa rapida"
- Nunca transforme a conversa em apresentacao
- Nunca fale valores de comissao, custos de licenca ou estrutura de remuneracao
- "Quanto vou ganhar?" → "Essa parte ${article} ${specialist} vai te explicar, depende de alguns fatores"
- "Quanto custa?" → "Existe um processo inicial com licencas, mas ${article} ${specialist} te explica direitinho"

PREFERENCIA DE HORARIO:
${timeSlotRule}
- Sempre ofereça exatamente 2 opcoes
- Formato: "[dia] as [hora] da tarde ou [dia] as [hora] da noite. Qual funciona melhor pra vc?"

OBJECOES DE RECRUTAMENTO:
- "Nao tenho experiencia" → "E nem precisa ter. Muita gente comeca do zero"
- "Nao tenho tempo" → "Entendo. E rapido, uns 20 minutos. ${articleCap} ${specialist} vai direto pro que faz sentido pro seu caso"
- "Preciso pensar" → "Claro. Mas a conversa serve exatamente pra vc ter informacao suficiente pra pensar com clareza"
- "Tenho medo" → "Por isso a conversa ajuda. Vc entende o suporte e o processo antes de decidir qualquer coisa"
- "E golpe/piramide?" → "Entendo sua preocupacao. A [empresa] e uma empresa registrada e regulamentada. ${articleCap} ${specialist} pode te mostrar tudo na conversa"
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

  return `## TOM DE VOZ
${blocks.join("\n\n")}

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
    return `- key: "${field.key}" | label: "${field.label}" | ${req}`;
  });

  return `## DADOS PARA COLETAR (colete de forma NATURAL, dentro da conversa)
${fieldDefs.join("\n")}

COMO COLETAR:
- Conduza a conversa de forma natural seguindo as instruções do administrador acima
- NAO faca perguntas roboticas tipo "Qual seu nome completo?" — integre na conversa
- Se o lead mencionar dados espontaneamente, EXTRAIA e salve no collected_data
- Se o lead responder varios dados de uma vez, extraia TODOS
- Campos já preenchidos (ver CONTEXTO ATUAL na user message) nao devem ser perguntados
- Se ja perguntou 2 vezes por um campo e o lead ignorou, PULE e siga em frente
- Se o lead demonstrar aceite ("sim", "topo", "quero"), AGENDE mesmo com campos faltantes

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
function buildConversationRulesSection(_c: PromptContext): string {
  return `## REGRAS DE CONVERSA

CONTINUIDADE:
- Leia o histórico ANTES de responder — nunca repita cumprimento ou pergunta já feita
- Se já se apresentou, vá direto ao ponto na próxima mensagem
- Cada mensagem deve AVANÇAR a conversa

SITUAÇÕES ESPECIAIS:
- "depois" / "to ocupado" → encerre educadamente, status = "stale"
- Lead volta depois → retome de onde parou
- Pede humano → status = "handed_off"
- "não quero" / "cancela" (2ª vez) → status = "disqualified"
- Mensagem incompreensível → peça para repetir de forma natural
- Nunca insista mais que 2x na mesma pergunta`;
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

  const tzOffsetMap: Record<string, string> = {
    ET: "-04:00", CT: "-05:00", MT: "-06:00", PT: "-07:00",
  };
  const tzOffset = tzOffsetMap[tzLabel] || "-04:00";

  return `## AGENDAMENTO
Timezone padrão: ${tzLabel} (${effectiveTimezone})

REGRA DE TIMEZONE:
- Presuma que o lead esta no ${tzLabel}. NAO pergunte o timezone — mencione naturalmente (ex: "2 PM ${tzLabel}")
- Se o lead corrigir o timezone, ajuste
- start_time DEVE usar offset ${tzOffset}

FLUXO DE AGENDAMENTO (rapido e fluido):
- Quando todos os dados estiverem coletados, proponha 2 horarios da lista NA MESMA MENSAGEM
- Consulte "HORÁRIOS DISPONÍVEIS" no CONTEXTO ATUAL (user message) para os slots reais
- Exemplo: "Tenho horario amanha as 11 AM ou 2 PM ${tzLabel}, qual vc prefere?"
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

function buildCustomInstructionsSection(ctx: PromptContext): string {
  if (!ctx.config.custom_instructions) return "";
  let instructions = ctx.config.custom_instructions.substring(0, 3000);
  instructions = instructions
    .replace(/\{contact\.name\}/g, ctx.contactName)
    .replace(/\{agent\.name\}/g, ctx.config.personality?.name || "Agente")
    .replace(/\{location\.name\}/g, ctx.locationName)
    .replace(/\{agent\.specialist\}/g, ctx.config.specialist_name || "especialista");
  return `## INSTRUÇÕES DO ADMINISTRADOR (seguir com PRIORIDADE)
${instructions}`;
}

function buildExamplesSection(ctx: PromptContext): string {
  if (!ctx.config.conversation_examples) return "";
  return `## EXEMPLOS DE CONVERSA IDEAL
Os exemplos abaixo mostram o tom e fluxo desejado pelo administrador:

${ctx.config.conversation_examples.substring(0, 2000)}`;
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
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "field_key", "value", "tag", "calendar_id", "start_time", "appointment_id", "title", "pipeline_id", "stage_id"],
            properties: {
              type: {
                type: "string",
                enum: ["send_message", "update_field", "add_tag", "remove_tag", "book_appointment", "reschedule_appointment", "move_pipeline"],
              },
              field_key: { type: ["string", "null"] },
              value: { type: ["string", "null"] },
              tag: { type: ["string", "null"] },
              calendar_id: { type: ["string", "null"] },
              start_time: { type: ["string", "null"] },
              appointment_id: { type: ["string", "null"] },
              title: { type: ["string", "null"] },
              pipeline_id: { type: ["string", "null"] },
              stage_id: { type: ["string", "null"] },
            },
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
  agentType?: "sales_agent" | "recruitment_agent";
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

  const contextDesc = isRecruitment
    ? `Voce esta retomando contato com alguem que demonstrou interesse em uma oportunidade de carreira/recrutamento.
Foque em despertar curiosidade sobre a oportunidade profissional. NAO fale sobre venda de seguros.
${ctx.config.specialist_name ? `Mencione que ${ctx.config.specialist_name} pode explicar melhor numa conversa rapida.` : ""}`
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

## CONTEXTO
${contextDesc}${collectedBlock}${historyBlock}

## REGRAS
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
  "message": "sua mensagem",
  "should_send_message": true,
  "actions": [],
  "collected_data": {},
  "conversation_status": "active"
}

SEMPRE envie a mensagem. should_send_message deve ser SEMPRE true.`;
}
