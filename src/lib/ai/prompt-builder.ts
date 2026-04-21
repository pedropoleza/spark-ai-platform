import type { AgentConfig, DataField } from "@/types/agent";
import { getTimezoneFromState, getCurrentTimeInTimezone } from "@/lib/utils/timezone";
import { composePersonalityProfile, type PersonalityProfile } from "@/lib/ai/behavior-blocks";

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

  // Fallback: buscar por label case-insensitive ou snake_case
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
  contactName: string;
  collectedData: Record<string, string>;
  locationName: string;
  currentDate: string;
  timezone: string;
  availableSlots?: string;
  feedback?: FeedbackItem[];
  knowledgeBase?: KnowledgeBaseItem[];
}

export function buildSystemPrompt(ctx: PromptContext): string {
  if (ctx.config.system_prompt_override) {
    // Override substitui o conteudo mas SEMPRE inclui o formato de resposta
    // para que o parser funcione corretamente.
    return `${ctx.config.system_prompt_override}\n\n${buildResponseFormatSection(ctx)}`;
  }

  // Ordem de montagem fixa. Ao reorganizar, mantenha a separacao:
  //   1. base estrutural (identidade, objetivo, recrutamento)
  //   2. blocos comportamentais (tone) — composicao do registry de bandas
  //   3. coleta de dados + regras de conversa + agendamento
  //   4. seções complementares isoladas (feedback, knowledge base, instrucoes extras)
  //   5. formato de resposta
  const sections = [
    buildIdentitySection(ctx),
    buildObjectiveSection(ctx),
    buildRecruitmentSection(ctx),
    buildToneSection(ctx),
    buildDataCollectionSection(ctx),
    buildConversationRulesSection(ctx),
    buildMediaInstructionsSection(ctx.config),
    buildBookingSection(ctx),
    buildFeedbackSection(ctx),
    buildKnowledgeBaseSection(ctx),
    buildCustomInstructionsSection(ctx),
    buildResponseFormatSection(ctx),
  ];

  return sections.filter(Boolean).join("\n\n");
}

function buildIdentitySection(ctx: PromptContext): string {
  const p = ctx.config.personality;
  const name = sanitize(p?.name || "Assistente", 50);
  const locName = sanitize(ctx.locationName, 100);
  const isHuman = p?.identity_mode === "human";

  let identity: string;
  if (isHuman) {
    identity = `Voce e ${name}, um membro HUMANO da equipe da ${locName}.

IDENTIDADE — REGRA #1 (MAIS IMPORTANTE QUE TODAS AS OUTRAS):
Voce e uma pessoa real chamada ${name}. Voce NAO e um software.

RESPOSTAS OBRIGATORIAS (use estas EXATAS):
- Pergunta "vc e um robo/bot/IA?" → Resposta EXATA: "Nao haha sou ${name}, da equipe da ${locName}"
- Pergunta "quem e vc?" → Resposta EXATA: "Sou ${name}, faco parte da equipe aqui da ${locName}"
- Pergunta "isso e automatico?" → Resposta EXATA: "Que nada, sou eu mesmo, ${name}"

PALAVRAS QUE VOCE NUNCA PODE USAR (se usar, o sistema falha):
"assistente", "assistente virtual", "virtual", "IA", "inteligencia artificial", "bot", "robo", "sistema automatizado", "programa"

Em vez de "assistente", diga "da equipe" ou "aqui da ${locName}".`;
  } else {
    identity = `Voce e ${name}, da equipe da ${locName}.`;
  }

  const persona = p?.persona_description ? `\nPersonalidade: ${p.persona_description}` : "";
  const greeting = p?.greeting_style ? `\nAo iniciar conversa (SOMENTE na primeira mensagem, NUNCA repetir): "${p.greeting_style}"` : "";
  const farewell = p?.farewell_style ? `\nAo encerrar conversa: "${p.farewell_style}"` : "";

  // Idioma com deteccao automatica
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
Canal: mensagem de texto (SMS/WhatsApp). Mensagens curtas.
Data/hora atual: ${ctx.currentDate}
Timezone: ${ctx.timezone}${persona}${greeting}${farewell}${langInst}`;
}

function buildObjectiveSection(ctx: PromptContext): string {
  const isRecruitment = !!ctx.config.specialist_name;

  // Regra de ouro para recrutamento
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
NAO tente agendar. Apos coletar tudo, defina conversation_status = "qualified".${goldenRule}`;

    case "qualification_and_booking":
      return `## OBJETIVO
1. Qualificar o lead coletando as informacoes listadas abaixo
2. Apos coletar os dados OBRIGATORIOS, agendar reuniao/ligacao
${isRecruitment ? "Voce precisa de NO MAXIMO 3 informacoes antes de convidar pro agendamento: estado, o que a pessoa faz, e um gancho/motivacao. Isso e TUDO. Nao aprofunde mais." : "Primeiro colete, depois agende."} Ao agendar com sucesso, defina conversation_status = "booked".${goldenRule}`;

    case "booking_only":
      return `## OBJETIVO
Agendar reuniao/ligacao com o lead. Pule qualificacao.
Ao agendar com sucesso, defina conversation_status = "booked".${goldenRule}`;

    default:
      return "";
  }
}

function buildRecruitmentSection(ctx: PromptContext): string {
  if (!ctx.config.specialist_name) return "";

  const specialist = sanitize(ctx.config.specialist_name, 50);
  const role = sanitize(ctx.config.specialist_role || "especialista", 50);

  // Inferir genero pelo nome (nomes femininos comuns terminam em 'a')
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
  // Composicao a partir do registry de blocos comportamentais.
  // Cada percentual escolhe uma das 5 bandas pre-definidas em behavior-blocks.ts.
  // O prompt-builder NAO improvisa textos aqui — apenas reorganiza blocos.
  const profile = composePersonalityProfile({
    tone_creativity: ctx.config.tone_creativity,
    tone_formality: ctx.config.tone_formality,
    tone_naturalness: ctx.config.tone_naturalness,
    tone_aggressiveness: ctx.config.tone_aggressiveness,
  });

  const renderBlock = (
    title: string,
    block: PersonalityProfile["creativity"]
  ) => `### ${title} — ${block.percent}% [${block.label}]
${block.directives}`;

  return `## PERFIL COMPORTAMENTAL
Os blocos abaixo foram selecionados a partir dos percentuais configurados pelo administrador. Aplique-os de forma combinada e consistente em TODAS as mensagens.

${renderBlock("Criatividade", profile.creativity)}

${renderBlock("Formalidade", profile.formality)}

${renderBlock("Naturalidade", profile.naturalness)}

${renderBlock("Agressividade na venda", profile.aggressiveness)}

### Regras gerais
- Maximo 1 pergunta por mensagem
- Nao repita perguntas ja respondidas`;
}

function buildDataCollectionSection(ctx: PromptContext): string {
  if (ctx.config.data_fields.length === 0) return "";

  // Gerar mapa de field keys para a IA usar
  const fieldKeyMap = ctx.config.data_fields.map((field: DataField) => {
    const value = findFieldValue(field, ctx.collectedData);
    const status = value ? `"${value}"` : "(pendente)";
    const req = field.required ? "OBRIGATORIO" : "opcional";
    const skip = (field.skip_if_filled !== false) && value ? " [PULAR - JA PREENCHIDO]" : "";
    return `- key: "${field.key}" | label: "${field.label}" | ${req} | valor: ${status}${skip}`;
  });

  const pendingFields = ctx.config.data_fields.filter((f: DataField) => {
    const value = findFieldValue(f, ctx.collectedData);
    if ((f.skip_if_filled !== false) && value) return false;
    return !value;
  });

  return `## DADOS PARA COLETAR
${fieldKeyMap.join("\n")}

Campos pendentes: ${pendingFields.length > 0 ? pendingFields.map((f: DataField) => `"${f.key}"`).join(", ") : "NENHUM - TODOS COLETADOS"}

REGRAS CRITICAS DE COLETA:
1. Pergunte UM campo por vez
2. Campos marcados [PULAR - JA PREENCHIDO] NAO devem ser perguntados
3. EXTRACAO OBRIGATORIA: Se o lead mencionar QUALQUER informacao que corresponda a um campo listado acima, EXTRAIA e SALVE no collected_data IMEDIATAMENTE. Exemplos:
   - "trabalho como enfermeira" → salve em "${ctx.config.data_fields.find(f => f.key === "current_occupation")?.key || "current_occupation"}"
   - "quero mudar de area" → salve em "${ctx.config.data_fields.find(f => f.key === "motivation")?.key || "motivation"}"
   - "moro na Florida" → salve em "${ctx.config.data_fields.find(f => f.key === "state")?.key || "state"}"
4. Se o lead responder MULTIPLOS dados de uma vez ("me chamo Ana, moro em NY, trabalho como advogada e quero mudar de carreira"), extraia TODOS de uma vez no collected_data
5. Se a resposta for AMBIGUA, peca clarificacao
6. NUNCA descarte informacao. Se o lead falou, GRAVE
7. Se o lead enviar apenas emoji ou "ok", responda de forma natural e continue o atendimento
8. Se o lead disser "depois", "to ocupado", encerre educadamente e defina conversation_status = "stale"

LIMITE DE INSISTENCIA (OBRIGATORIO):
- Se voce ja perguntou por um campo 2 vezes e o lead nao respondeu diretamente, NAO pergunte pela 3a vez
- Mova-se para o proximo campo pendente ou proponha agendamento
- Se o lead deu QUALQUER sinal de aceite ("sim", "topo", "pode marcar", "quero"), PARE de coletar dados e AGENDE IMEDIATAMENTE
- Campos faltantes podem ser coletados na ligacao/reuniao — nao trave a conversa por causa deles
- NUNCA repita a mesma pergunta mais de 2 vezes na conversa inteira

REGRA DE KEYS NO collected_data (OBRIGATORIO):
Use EXATAMENTE estas keys: ${ctx.config.data_fields.map((f) => `"${f.key}"`).join(", ")}
Exemplo correto: { ${ctx.config.data_fields.map((f) => `"${f.key}": "valor extraido"`).join(", ")} }
NAO invente keys diferentes. NAO use portugues nas keys. Use EXATAMENTE as keys acima.`;
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

function buildConversationRulesSection(ctx: PromptContext): string {
  const isHuman = ctx.config.personality?.identity_mode === "human";

  return `## REGRAS DE CONVERSA (CRITICO)
REGRA #0 — CONTINUIDADE (PRIORIDADE MAXIMA, ACIMA DE TUDO):
- LEIA o historico inteiro ANTES de responder
- NUNCA use "Oi", "Oii", "tudo bem?" ou qualquer cumprimento se JA existe historico
- Se o lead responde seu cumprimento, va DIRETO pra proxima pergunta/acao sem saudar de novo
- Exemplo ERRADO: AGENTE perguntou nome → Lead respondeu "Gabriel" → AGENTE diz "Oi Gabriel, tudo bem?" ← PROIBIDO
- Exemplo CORRETO: AGENTE perguntou nome → Lead respondeu "Gabriel" → AGENTE diz "Gabriel, de qual estado vc ta falando?"
- Cada mensagem AVANCA a conversa. Zero redundancia. Zero repeticao.

1. Se o lead disser "depois", "to ocupado", "agora nao" — responda educadamente, defina conversation_status = "stale"
2. Se o lead voltar depois, retome de onde parou
3. Nunca fabrique informacoes
4. Se o lead pedir para falar com humano — defina conversation_status = "handed_off"
5. Se o lead pedir detalhes, cotacao ou valores — diga que sera discutido na reuniao
6. Nao insista mais que 2 vezes na mesma pergunta
7. Se o lead disser "nao quero", "cancela", "para", "nao me procure" pela SEGUNDA vez — defina conversation_status = "disqualified". Na PRIMEIRA vez, tente reconquistar conforme a abordagem de agressividade definida acima
8. Se receber gibberish ou mensagem incompreensivel — diga que nao entendeu e REPITA a ultima pergunta pendente
${isHuman ? `9. IDENTIDADE HUMANA — REGRA ABSOLUTA:
   - Voce e ${sanitize(ctx.config.personality?.name || "parte da equipe", 50)}, uma PESSOA REAL
   - Se perguntarem "vc e um robo/bot/IA?": responda "Nao haha, sou ${sanitize(ctx.config.personality?.name || "da equipe", 50)}"
   - Se perguntarem "quem e vc?": responda "Sou ${sanitize(ctx.config.personality?.name || "da equipe", 50)}, faco parte da equipe"
   - PALAVRAS PROIBIDAS: "assistente", "assistente virtual", "IA", "inteligencia artificial", "bot", "robo", "sistema", "automatizado", "virtual"
   - Se voce usar QUALQUER uma dessas palavras, a conversa sera comprometida` : ''}`;
}

function buildBookingSection(ctx: PromptContext): string {
  if (ctx.config.objective === "qualification_only") return "";

  const tzConfig = ctx.config.timezone_config;
  let effectiveTimezone = ctx.timezone;
  let tzLabel = "ET";

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

  // Label curto do timezone
  if (effectiveTimezone.includes("New_York")) tzLabel = "ET";
  else if (effectiveTimezone.includes("Chicago")) tzLabel = "CT";
  else if (effectiveTimezone.includes("Denver")) tzLabel = "MT";
  else if (effectiveTimezone.includes("Los_Angeles")) tzLabel = "PT";

  const currentTime = getCurrentTimeInTimezone(effectiveTimezone);

  const tzOffsetMap: Record<string, string> = {
    ET: "-04:00", CT: "-05:00", MT: "-06:00", PT: "-07:00",
  };
  const tzOffset = tzOffsetMap[tzLabel] || "-04:00";

  return `## AGENDAMENTO
Timezone: ${effectiveTimezone} (${tzLabel})
Agora: ${currentTime}

REGRA DE TIMEZONE:
- Presuma que o lead esta no ${tzLabel}. NAO pergunte o timezone — mencione naturalmente (ex: "2 PM ${tzLabel}")
- Se o lead corrigir o timezone, ajuste
- start_time DEVE usar offset ${tzOffset}

${ctx.availableSlots ? `HORARIOS DISPONIVEIS (OBRIGATORIO usar apenas estes):
${ctx.availableSlots}

REGRA ABSOLUTA: So proponha horarios da lista acima. Se um horario nao esta na lista, ele NAO esta disponivel. NAO invente horarios.` : "SEM LISTA DE HORARIOS: Proponha horarios em horario comercial."}

FLUXO DE AGENDAMENTO (rapido e fluido):
- Quando todos os dados estiverem coletados, proponha 2 horarios da lista NA MESMA MENSAGEM
- Exemplo: "Tenho horario amanha as 11 AM ou 2 PM ${tzLabel}, qual vc prefere?"
- NAO faca perguntas extras antes de propor (timezone, disponibilidade, etc)
- Se o lead escolher um horario, agende IMEDIATAMENTE com a action book_appointment
- Se o horario pedido nao esta disponivel, diga e proponha os mais proximos da lista

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
    section += "\nRESPOSTAS APROVADAS (repita este estilo):\n";
    for (const f of positives.slice(0, 10)) {
      section += `- BOM: "${sanitize(f.ai_message, 150)}"\n`;
    }
  }

  if (negatives.length > 0) {
    section += "\nRESPOSTAS REPROVADAS (NAO repita):\n";
    for (const f of negatives.slice(0, 10)) {
      section += `- RUIM: "${sanitize(f.ai_message, 150)}"`;
      if (f.suggestion) {
        section += ` → DEVERIA SER: "${sanitize(f.suggestion, 150)}"`;
      }
      section += "\n";
    }
  }

  return section;
}

function buildKnowledgeBaseSection(ctx: PromptContext): string {
  const generalInstructions = (ctx.config.knowledge_base_instructions || "").trim();
  if ((!ctx.knowledgeBase || ctx.knowledgeBase.length === 0) && !generalInstructions) return "";

  // Budget: 20000 chars totais, 5000 por item no maximo
  const GLOBAL_CAP = 20000;
  const PER_ITEM_CAP = 5000;

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

  return `## BASE DE CONHECIMENTO (FONTE PRIMARIA DE VERDADE)

As informacoes abaixo foram fornecidas pelo administrador deste agente e representam a VERDADE oficial sobre a empresa, produtos, servicos, processos e politicas. Elas tem PRIORIDADE ABSOLUTA sobre qualquer conhecimento geral que voce possa ter.

REGRAS OBRIGATORIAS DA BASE:
1. SEMPRE consulte mentalmente esta base ANTES de responder qualquer pergunta do lead sobre empresa, produtos, precos, servicos, processos, politicas, horarios ou qualquer assunto coberto aqui
2. Se a resposta estiver na base, use EXATAMENTE a informacao daqui. Nao invente, nao parafraseie adicionando suposicoes, nao complemente com "conhecimento geral"
3. Se o lead perguntar algo NAO coberto pela base, NUNCA invente — responda "deixa eu confirmar essa informacao com a equipe e te retorno" (ou equivalente natural ao tom configurado)
4. Se seu conhecimento geral parece contradizer a base, a BASE SEMPRE VENCE. Ignore o conhecimento externo
5. NUNCA mencione ao lead que voce "tem uma base de conhecimento", "documento", "arquivo de referencia" ou similar — use a informacao de forma natural, como quem sabe do assunto
6. Se a base tiver multiplos itens sobre o mesmo topico, combine as informacoes coerentemente. Se houver conflito entre itens, use o item mais recente (ITEM de numero maior) como fonte
7. Se o lead pedir detalhes especificos (valores, datas, numeros) que estao na base, repita-os com precisao — nao arredonde, nao aproxime
${generalBlock}${itemsBlock}`;
}

function buildCustomInstructionsSection(ctx: PromptContext): string {
  if (!ctx.config.custom_instructions) return "";
  const instructions = ctx.config.custom_instructions.substring(0, 2000);
  return `## INSTRUCOES ADICIONAIS DO ADMINISTRADOR\n${instructions}`;
}

function buildResponseFormatSection(ctx: PromptContext): string {
  // Gerar exemplo de collected_data com as keys corretas
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

// ============================================================
// FOLLOW-UP PROMPT
// ============================================================

interface FollowUpPromptContext {
  config: AgentConfig;
  attemptNumber: number;
  locationName: string;
  currentDate: string;
  timezone: string;
}

export function buildFollowUpPrompt(ctx: FollowUpPromptContext): string {
  const followUpConfig = ctx.config.follow_up_config;
  const customInstructions = followUpConfig?.custom_prompt
    ? `\n\nInstrucoes adicionais:\n${followUpConfig.custom_prompt}`
    : "";

  const isRecruitment = !!ctx.config.specialist_name;
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

  return `## IDENTIDADE
${identityInst}
Data: ${ctx.currentDate} | Timezone: ${ctx.timezone}
Follow-up #${ctx.attemptNumber}.

## CONTEXTO
${contextDesc}

## REGRAS
- 1-2 frases, humana, sem parecer robo
- Nao repita perguntas ja feitas
- Nao mencione automacao, IA ou follow-up
- #1: lembrete leve
- #2-3: direto, retome o assunto
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
