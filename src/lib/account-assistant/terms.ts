/**
 * Termos de uso do SparkBot. Enviados automaticamente no primeiro contato
 * do rep. Ele só começa a usar após aceitar explicitamente.
 */

export const TERMS_OF_USE_TEXT = `Oi! Sou o SparkBot, o assistente da sua conta.

Antes de começar, só pra você saber como funciona:

1. ACESSO AO SEU CRM
Consigo consultar e modificar dados dos seus contatos, oportunidades, tarefas e agenda no Spark Leads — sempre respeitando as permissões que você já tem por lá.

2. O QUE EU FAÇO
Executo ações que você me pedir em linguagem natural (texto, áudio, foto ou documento). Exemplos: "adiciona nota no João", "cria tarefa pra ligar amanhã", "quais opportunities tão abertas?".

3. O QUE EU ANOTO DE VOCÊ
Com o tempo vou aprendendo suas preferências (tom que gosta, horários que responde, leads importantes pra você) pra ficar mais útil. Isso fica salvo de forma privada, só associado a você.

4. O QUE PODE DAR ERRADO
Sou uma IA. Às vezes erro interpretando pedidos. Por isso, em ações que mudam algo importante, eu confirmo antes. Se algo sair errado, me fala e eu tento reverter.

5. LIMITES
Não mando mensagens pros seus leads sem você confirmar. Não apago nada sem você confirmar. Não falo com mais ninguém sobre você ou seus contatos.

6. PARAR DE USAR
É só mandar "parar" ou "desativar" que eu silencio. Pra apagar tudo que sei sobre você, manda "apagar meus dados" que o admin da sua conta remove.

Tá ok? Responde "aceito" pra gente começar.`;

/** Palavras que contam como aceite. */
const ACCEPT_KEYWORDS = [
  "aceito", "aceita", "ok", "okay", "sim", "concordo", "concordado",
  "beleza", "blz", "pode", "pode sim", "tá", "ta", "combinado", "fechado",
  "👍", "✅",
];

/** Palavras que contam como recusa. */
const REJECT_KEYWORDS = [
  "nao", "não", "no", "recuso", "não aceito", "nao aceito", "nunca",
];

export function parseTermsResponse(text: string): "accept" | "reject" | "unclear" {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "unclear";

  if (REJECT_KEYWORDS.some((k) => normalized === k || normalized.startsWith(k + " "))) {
    return "reject";
  }
  if (ACCEPT_KEYWORDS.some((k) => normalized === k || normalized.startsWith(k + " ") || normalized.includes(" " + k))) {
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
    ? `\n\nVi que tua conta tá em *${humanLocation}* — vou usar esse fuso pra agendamentos.\nSe tu mudar de cidade, é só me avisar ("tô em SP agora") que eu ajusto.\n\n`
    : "\n\n";
  return (
    "Beleza, termos aceitos. ✓" +
    fusoBlock +
    "Algumas coisas que eu posso fazer:\n" +
    "• \"me lembra em 30min de ligar pro João\" — agendo lembrete\n" +
    "• \"que appointments tenho hoje?\" — lista do CRM\n" +
    "• \"cria nota no Pedro Silva: cliente quer Term\" — no Spark Leads\n" +
    "• \"qual o cap do FlexLife em FL?\" — consulto na NLG\n\n" +
    "Manda áudio, foto ou doc também — eu processo. Qualquer dúvida, é só perguntar."
  );
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
