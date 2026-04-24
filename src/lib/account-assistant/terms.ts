/**
 * Termos de uso do Sparkbot. Enviados automaticamente no primeiro contato
 * do rep. Ele só começa a usar após aceitar explicitamente.
 */

export const TERMS_OF_USE_TEXT = `Oi! Sou o Sparkbot, o assistente da sua conta.

Antes de começar, só pra você saber como funciona:

1. ACESSO AO SEU CRM
Consigo consultar e modificar dados dos seus contatos, oportunidades, tarefas e agenda no GoHighLevel — sempre respeitando as permissões que você já tem por lá.

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

/** Mensagem após aceite. */
export const TERMS_ACCEPTED_TEXT =
  "Beleza. Pode me pedir o que precisar — texto, áudio, foto ou documento funcionam.";

/** Mensagem após rejeição. */
export const TERMS_REJECTED_TEXT =
  "Entendi. Se mudar de ideia é só me chamar de novo. Tchau!";
