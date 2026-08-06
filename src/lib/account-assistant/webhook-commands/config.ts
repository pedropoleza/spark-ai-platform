/**
 * Flag do endpoint de comandos via webhook (H71).
 *
 * Default OFF, como toda feature nova do projeto — a flag existe como kill
 * switch: se uma automação entrar em loop, o Pedro desliga o endpoint inteiro
 * sem precisar de deploy.
 */
export function isWebhookCommandsEnabled(): boolean {
  const v = (process.env.SPARKBOT_WEBHOOK_COMMANDS_ENABLED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}
