/**
 * Strings user-facing da feature de Campanhas em Grupo (Pedro auto-aprovou
 * 2026-06-18; fonte: _planning/group-campaigns-whatsapp/COPY.md). Regra
 * inviolável: "Spark Leads"/"SparkBot", NUNCA "GHL"/"GoHighLevel".
 */

/**
 * Tutorial "enable group view": o SparkBot entrega quando o rep quer campanha de
 * grupo mas os grupos ainda não aparecem (lista vazia). Habilitar no painel
 * sincroniza os grupos do número. (Caminho confirmado pelo Pedro 2026-06-18.)
 */
export const ENABLE_GROUP_VIEW_TUTORIAL = `Pra eu enxergar e usar seus grupos, primeiro habilita a visualização de grupos no Spark Leads — leva 20 segundos:

1. No menu da *esquerda*, abre *WhatsApp*.
2. Vai em *Settings* (Configurações).
3. Na primeira aba, *General*, ativa a opção *"Enable group view"*.

Pronto — ele sincroniza seus grupos automaticamente. Me avisa quando ativar que eu já listo eles pra você. 📋`;

/**
 * Nudge do servidor dedicado: quando o rep NÃO tem instância dedicada, a tool
 * recusa o disparo e o bot responde com isto (caminho pra resolver, não erro seco).
 * O gancho do "parceiro de proxy doméstico" é o que o Pedro pediu.
 */
export const DEDICATED_SERVER_NUDGE = `Pra fazer campanha em grupo com segurança, você precisa de um *número dedicado* — separado do seu WhatsApp do dia a dia. Isso protege seu número principal de bloqueio.

A gente trabalha com um parceiro de proxy doméstico que monta esse servidor dedicado pra você (a partir de ~$5). Quer que eu abra um pedido pro suporte preparar o seu? 🚀`;

/** Grupo announce-only (só admin posta) + rep possivelmente não-admin. */
export function announceWarning(groupName: string): string {
  return `⚠️ O grupo "${groupName}" só deixa *admins* postarem. Se você não for admin nele, o post não vai sair. Confere isso antes — ou escolhe outro grupo.`;
}
