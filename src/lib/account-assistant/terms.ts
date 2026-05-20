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
  /\b(nao|no|nunca|recuso|recus[ao]|jeito\s+nenhum|de\s+jeito|nem|nada|negativo|n[ãa]o\s+quero|n[ãa]o\s+aceito)\b/;

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

  // Fix CRITICAL Track 1 C2 (review 2026-05-05): regex anti-falso-positivo.
  // Antes, "não tá ok" virava ACCEPT por causa do `.includes(" ok")`.
  // Agora: SE houver QUALQUER negação detectada, é REJECT (fail-safe).
  if (NEGATION_PATTERN.test(normalized)) {
    return "reject";
  }

  // ACCEPT: whole-word match no início OU frase única.
  // NUNCA `.includes` no meio (causou falso positivo histórico).
  if (
    ACCEPT_KEYWORDS.some(
      (k) => normalized === k || normalized.startsWith(k + " "),
    )
  ) {
    return "accept";
  }
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
export function buildTermsInteractive(): {
  kind: "buttons";
  body: string;
  options: { id: string; label: string }[];
} {
  return {
    kind: "buttons",
    body: TERMS_OF_USE_TEXT,
    options: [
      { id: "terms_accept", label: "Aceito ✅" },
      { id: "terms_reject", label: "Não aceito ❌" },
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
