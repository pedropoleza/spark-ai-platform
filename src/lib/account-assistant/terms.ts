/**
 * Termos de uso do SparkBot. Enviados automaticamente no primeiro contato
 * do rep. Ele só começa a usar após aceitar explicitamente.
 */

export const TERMS_OF_USE_TEXT = `Oi! Sou o *SparkBot*, teu copiloto aqui no Spark Leads. 👋

Antes de começar, rapidinho:

*O que eu faço* — você me pede em texto, áudio, foto, planilha ou PDF e eu executo no seu CRM: notas, tarefas, lembretes, agendamentos, consultas, mover/criar oportunidades, disparos em massa, sequências de follow-up e busca por filtros. Também tiro dúvidas de produto (NLG/carriers).

*Suas informações* — acesso seus dados respeitando as permissões que você já tem, e aprendo suas preferências pra ficar mais útil. Fica privado, só seu.

*Segurança* — sou IA e posso errar interpretando. Por isso, em ações que mexem em algo importante (mandar msg pro cliente, apagar, agendar) eu *confirmo antes*. Não falo de você nem dos seus contatos com mais ninguém.

*Parar* — manda "parar" que eu silencio; "apagar meus dados" → o admin remove tudo.

Topa começar?`;

/** Palavras que contam como aceite (whole-word match no início ou frase única). */
const ACCEPT_KEYWORDS = [
  "aceito", "aceita", "ok", "okay", "sim", "concordo", "concordado",
  "beleza", "blz", "pode", "tá", "ta", "combinado", "fechado",
  "👍", "✅",
];

/** Padrões de negação — qualquer match dispara REJECT (fail-safe). */
const NEGATION_PATTERN =
  /\b(nao|n|no|nope|nunca|jamais|recuso|recus[ao]|jeito\s+nenhum|de\s+jeito|nem|nada|negativo|n[ãa]o\s+quero|n[ãa]o\s+aceito)\b/;

/**
 * Normaliza texto pra parsing: lowercase + remove acentos + remove pontuação.
 * Crítico pra "não aceito" não escapar do REJECT só por causa do acento.
 */
function normalizeForParse(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacríticos
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ");
}

export function parseTermsResponse(text: string): "accept" | "reject" | "unclear" {
  // Tira o sufixo de amarração do tap interativo: "Aceito ✅ — (resposta à
  // pergunta: '...termos cheios de não...')". Sem isso, os "não" do texto dos
  // termos disparariam o NEGATION_PATTERN e "Aceito" viraria REJECT. O label do
  // botão (antes do sufixo) é a fonte de verdade. (Pedro 2026-05-20)
  const label = text.split("(resposta à pergunta:")[0].replace(/\s*—\s*$/, "").trim();
  const normalized = normalizeForParse(label || text);
  if (!normalized) return "unclear";

  // Dígito seco = seleção do menu numerado do fallback (H52 review adversarial
  // 2026-07-17): o web_ui exibe "1. Aceito ✅ / 2. Não aceito ❌" e a resposta
  // mais natural a menu numerado no BR é SÓ o número — que caía em unclear e
  // re-enviava os termos (o loop do caso Willian, no formato mais provável).
  // O parser SÓ roda nos gates de termos, onde o menu tem exatamente essas 2
  // opções nessa ordem — mapear é determinístico e seguro.
  // Cobre também "1)", "(1)", "1." (R2: normalizeForParse não strippa
  // parênteses; só dígito+pontuação vazia — "10"/"2 pessoas" NÃO casam).
  if (/^\(?1[.)\]]?$/.test(normalized)) return "accept";
  if (/^\(?2[.)\]]?$/.test(normalized)) return "reject";

  // Fix CRITICAL Track 1 C2 (review 2026-05-05): "não tá ok" não pode virar
  // ACCEPT. Negação → REJECT.
  // Fix 2026-05-20 (bug observado: rep silenciado por comando): REJECT só pra
  // recusa CURTA e clara — NÃO uma negação enterrada num comando longo (ex:
  // áudio "cadastra o lead João, NÃO o frio" não é recusar os termos). Exige
  // negação + (mensagem curta ≤5 palavras OU começa com palavra de negação).
  const words = normalized.split(/\s+/).filter(Boolean);
  const firstWord = words[0] || "";
  const NEG_FIRST = new Set([
    "nao", "n", "no", "nunca", "nem", "nada", "negativo", "recuso", "recusa", "jamais", "nope",
  ]);

  // Fix review 2026-05-20 — RECUSA FORTE em QUALQUER posição → reject (LGPD:
  // honra um "não" explícito mesmo numa frase longa que não começa com negação).
  const STRONG_REFUSAL =
    /\b(recuso|recusa|jamais|de\s+jeito\s+nenhum|nao\s+quero|nao\s+aceito|nao\s+vou\s+usar|nao\s+usar|nope)\b/;
  if (STRONG_REFUSAL.test(normalized)) return "reject";

  // Recusa curta/clara: negação + (≤5 palavras OU começa com palavra de negação).
  if (NEGATION_PATTERN.test(normalized) && (words.length <= 5 || NEG_FIRST.has(firstWord))) {
    return "reject";
  }

  // ACCEPT: whole-word match no início OU frase única. NUNCA `.includes` no meio.
  //
  // Fix bug observado em prod 2026-07-17 (caso Willian, ultra-review P1-1): o
  // fallback do web_ui exibe as opções NUMERADAS ("1. Aceito ✅") e o PRÓPRIO
  // formato que o bot mostrava não passava aqui — o rep tentou aceitar ~12x
  // ("1. Aceito ✅", "1 aceito", "eu aceito os termos"), levou o mesmo reenvio
  // dos termos em <100ms cada vez e desistiu (churn fatal no onboarding).
  // Normalização adicional SÓ pro accept (reject já cobre esses formatos via
  // NEGATION/STRONG_REFUSAL no texto inteiro):
  //  - prefixo da opção de ACEITE ("1.", "1)", "1 -") cai fora. SÓ o "1"
  //    (H52 review adversarial): stripar qualquer dígito fazia "2 ok" —
  //    rep escolhendo a opção 2 = NÃO aceito — virar consentimento. "2 ..."
  //    sem negação explícita fica unclear (reenvia), nunca accept.
  //  - "eu" introdutório cai fora ("eu aceito os termos" → "aceito os termos").
  const denumbered = normalized
    .replace(/^1\s*[.)\-]?\s+/, "")
    .replace(/^eu\s+/, "");
  const accepts = ACCEPT_KEYWORDS.some(
    (k) =>
      normalized === k ||
      normalized.startsWith(k + " ") ||
      denumbered === k ||
      denumbered.startsWith(k + " "),
  );
  // "Yes-but-no" (aceite + negação no texto, ex: "aceito que errei mas não
  // concordo") → NÃO registra consentimento → unclear (re-pergunta). LGPD.
  if (accepts && NEGATION_PATTERN.test(normalized)) return "unclear";
  if (accepts) return "accept";
  return "unclear";
}

/** Mensagem de follow-up quando rep responde algo não claro. */
export const TERMS_REMINDER_TEXT =
  'Pra começarmos, me manda "aceito" (ou "não" pra encerrar). Depois posso te ajudar.';

/** Mensagem após aceite (legado — fallback se location.timezone não disponível). */
export const TERMS_ACCEPTED_TEXT =
  "Beleza, termos aceitos. ✓\n\nPode me pedir o que precisar — texto, áudio, foto ou documento funcionam.";

/** Mensagem após rejeição. */
export const TERMS_REJECTED_TEXT =
  "Entendi. Se mudar de ideia é só me chamar de novo. Tchau!";

/**
 * Mensagem composta após aceite que ALÉM de confirmar termos, já confirma
 * o fuso (lido da location do GHL) e mostra um guia rápido de exemplos.
 *
 * Pedro 2026-05-04: ao invés de perguntar fuso pro rep no onboarding, lê
 * direto da configuração da sub-account no GHL. Rep só precisa confirmar
 * se quiser mudar ("tô em SP agora" futuro).
 *
 * `humanLocation`: ex "Florida (EDT)" — formatado por `formatTimezoneHumanFriendly`.
 * Se null, omite seção de fuso (caller usa TERMS_ACCEPTED_TEXT).
 */
export function buildOnboardingMessage(humanLocation: string | null): string {
  const fusoBlock = humanLocation
    ? `\nTua conta tá em *${humanLocation}* — uso esse fuso pros agendamentos. Mudou de cidade? Só falar.\n\n`
    : "\n\n";
  return (
    "Fechou! Tô pronto. ✅" +
    fusoBlock +
    "Algumas coisas que dá pra pedir:\n" +
    "• \"me lembra em 30min de ligar pro João\" — agendo o lembrete\n" +
    "• \"que reuniões tenho hoje?\" — vejo tua agenda\n" +
    "• \"cria nota no Pedro Silva: cliente quer Term\" — anoto no Spark Leads\n" +
    "• \"manda 'oi, tudo bem?' pra +55 11 9…\" — eu confirmo e envio\n" +
    "• \"me mostra os leads sem oportunidade aberta\" — filtro na hora\n" +
    "• \"qual o cap do FlexLife em FL?\" — consulto na NLG\n\n" +
    "Manda áudio, foto, planilha ou PDF que eu processo. E quando eu te der opções, é só *tocar nos botões* — sem digitar. Qualquer coisa, é só pedir. 🚀"
  );
}

/**
 * Payload interativo dos termos: o texto dos termos no corpo + botões
 * Aceito/Não. Usado no primeiro contato (processor). Ids estáveis
 * `terms_accept`/`terms_reject`. No WhatsApp vira botão; em canal sem interativo
 * (ou flag off) o caller usa o texto-fallback (termos + opções numeradas).
 */
// Humanização (estudo 2026-06-24, fix 1.9): quando o rep já mandou um PEDIDO
// real (não só "oi"), o gate passa um `ackPrefix` reconhecendo a intenção pra o
// paredão de termos não soar como se estivesse ignorando ele (caso Matheus:
// tentou marcar Zoom 4× e levou o bloco de termos 4× sem reconhecimento).
export function buildTermsInteractive(ackPrefix?: string): {
  kind: "buttons";
  body: string;
  options: { id: string; label: string }[];
} {
  return {
    kind: "buttons",
    body: ackPrefix ? `${ackPrefix}\n\n${TERMS_OF_USE_TEXT}` : TERMS_OF_USE_TEXT,
    options: [
      { id: "terms_accept", label: "Aceito ✅" },
      { id: "terms_reject", label: "Não aceito ❌" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Terms & Segurança PARTE 2 — Campanhas em GRUPO (Pedro 2026-06-18)
// ---------------------------------------------------------------------------
// 2º consentimento, pedido UMA vez antes da primeira campanha de grupo. Reusa o
// MESMO parser (parseTermsResponse) — a semântica é a mesma (aceite/recusa por
// botão+texto, anti-falso-positivo LGPD). Diferença de POLÍTICA: REJECT aqui NÃO
// silencia o SparkBot (só bloqueia campanha de grupo). Copy aprovada pelo Pedro
// (auto-aprovação 2026-06-18; ver _planning/group-campaigns-whatsapp/COPY.md).

export const GROUP_CAMPAIGN_TERMS_TEXT = `📣 *Campanhas em grupos — antes de começar*

Postar em grupos de WhatsApp é poderoso, mas vem com responsabilidade. Preciso do seu ok em 3 pontos pra liberar essa função pra você:

• *Risco de bloqueio do número.* Enviar muita mensagem, repetida ou pra muita gente de uma vez, faz o WhatsApp marcar o número como spam — e ele pode ser *bloqueado*. Eu trabalho pra reduzir isso (espaço os envios, varia o texto, alterna entre grupos), mas o risco nunca é zero. O número é seu; a decisão de disparar é sua.

• *Você é responsável pelo conteúdo.* Nada de promessa de retorno garantido, esquema de renda, corrente ou spam. Mensagem honesta e relevante pro grupo. Eu te aviso se um texto parecer arriscado, mas a palavra final — e a responsabilidade — é sua.

• *Servidor dedicado recomendado.* Pra proteger seu número, o ideal é rodar campanha de grupo num *número/servidor dedicado* (separado do seu WhatsApp pessoal). A gente tem um parceiro de proxy doméstico que oferece esse servidor dedicado — ajuda bastante a evitar bloqueio. Se quiser, eu falo com o suporte pra te montar um. 💪

Topa seguir com essas condições?`;

/** Mensagem após aceite da Parte 2. */
export const GROUP_CAMPAIGN_TERMS_ACCEPTED_TEXT =
  "Fechou! ✅ Campanhas em grupos liberadas pra você. Quando quiser, é só me dizer o grupo e a mensagem que eu cuido do resto.";

/** Mensagem após recusa da Parte 2 (NÃO silencia o resto do SparkBot). */
export const GROUP_CAMPAIGN_TERMS_REJECTED_TEXT =
  "Sem problema! 👍 Sigo te ajudando com tudo o mais normalmente. Se mudar de ideia sobre campanhas em grupo, é só falar comigo.";

/** Follow-up quando a resposta à Parte 2 não é clara. */
export const GROUP_CAMPAIGN_TERMS_REMINDER_TEXT =
  'Pra liberar campanhas em grupo, me confirma: responde "aceito" (ou "não" se preferir não usar agora).';

/**
 * Payload interativo da Parte 2 (corpo dos termos de grupo + botões). Ids
 * próprios (`group_terms_*`) pra não colidir com a Parte 1. parseTermsResponse é
 * reusado tal-qual (a extração de label cobre o sufixo de tap).
 */
export function buildGroupCampaignTermsInteractive(): {
  kind: "buttons";
  body: string;
  options: { id: string; label: string }[];
} {
  return {
    kind: "buttons",
    body: GROUP_CAMPAIGN_TERMS_TEXT,
    options: [
      { id: "group_terms_accept", label: "Aceito ✅" },
      { id: "group_terms_reject", label: "Agora não ❌" },
    ],
  };
}

/**
 * Mapa cidade-amigável pros IANA timezones mais comuns no mercado da Brazillionaires
 * (agentes brasileiros nos EUA). Fallback usa última parte do IANA.
 */
const TZ_CITY_MAP: Record<string, string> = {
  "America/New_York": "Florida",       // pode ser NY mas Brazillionaires opera em FL
  "America/Sao_Paulo": "São Paulo",
  "America/Los_Angeles": "Los Angeles",
  "America/Chicago": "Chicago",
  "America/Denver": "Denver",
  "America/Phoenix": "Phoenix",
  "America/Anchorage": "Anchorage",
  "America/Honolulu": "Honolulu",
  "Pacific/Honolulu": "Honolulu",
  "America/Fortaleza": "Fortaleza",
  "America/Recife": "Recife",
  "America/Manaus": "Manaus",
  "America/Bahia": "Salvador",
  "America/Belem": "Belém",
};

/**
 * "America/New_York" → "Florida (EDT)"
 * "America/Sao_Paulo" → "São Paulo (BRT)"
 * Usa Intl.DateTimeFormat pra pegar a abbreviation correta na data atual
 * (EDT vs EST muda com DST).
 */
export function formatTimezoneHumanFriendly(iana: string | null | undefined): string | null {
  if (!iana) return null;
  let city = TZ_CITY_MAP[iana];
  if (!city) {
    // Fallback: pega "Sao_Paulo" do "America/Sao_Paulo" e troca _ por space
    const lastPart = iana.split("/").pop();
    city = lastPart ? lastPart.replace(/_/g, " ") : iana;
  }
  let abbrev = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === "timeZoneName")?.value;
    abbrev = tz ? ` (${tz})` : "";
  } catch {
    // IANA inválido — segue só com city name
  }
  return `${city}${abbrev}`;
}
