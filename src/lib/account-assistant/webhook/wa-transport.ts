/**
 * Qual motor de WhatsApp o SparkBot usa pra falar com o rep (H57).
 *
 * CONTEXTO (Pedro 2026-07-28): o Stevo é um white-label de painel, sem API de
 * webhook, que já nos deixou 19h mudos (apagão 2026-06-17) e muda comportamento
 * sem aviso. A Spark passou a ter engine própria — o **SparkZap** — que já roda
 * o inbox de suporte e os números dos clientes. Este módulo é a chave de
 * transporte: `stevo` (default, nada muda) × `sparkzap` (sai pela nossa engine,
 * via Spark OS).
 *
 * Plano/decisões: `_planning/sparkzap-transporte/PLANO.md` e, do lado do OS,
 * `spark-os/_planning/SPARKBOT_SPARKZAP_BRIDGE.md`.
 *
 * ROLLOUT gradual por REP (padrão log-first da casa): `SPARKZAP_REPS` é uma
 * lista de telefones E.164 separados por vírgula. Com a lista preenchida, só
 * eles saem pelo SparkZap — todo o resto segue no Stevo. Lista VAZIA +
 * `SPARKBOT_WA_TRANSPORT=sparkzap` = todos. Rollback = voltar a env.
 */

export type WaTransport = "stevo" | "sparkzap";

/** Só dígitos — compara telefone sem depender de "+", espaço ou parênteses. */
function digits(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/** Allowlist de reps (telefones) que já usam o SparkZap. Vazia = sem filtro. */
export function sparkZapAllowlist(): string[] {
  return (process.env.SPARKZAP_REPS || "")
    .split(",")
    .map((s) => digits(s))
    .filter((s) => s.length >= 8);
}

/**
 * Decide o transporte pra ESTE rep.
 *
 * @param phone telefone do rep (qualquer formato). Omitido = decisão global.
 */
export function pickWaTransport(phone?: string | null): WaTransport {
  const configured = (process.env.SPARKBOT_WA_TRANSPORT || "stevo").trim().toLowerCase();
  if (configured !== "sparkzap") return "stevo";

  const allow = sparkZapAllowlist();
  if (allow.length === 0) return "sparkzap";

  const d = digits(phone || "");
  if (!d) return "stevo"; // sem telefone não dá pra afirmar que está no rollout
  // Compara pelo SUFIXO em ambos os sentidos: a lista pode estar escrita com ou
  // sem DDI (+17867717077 × 7867717077) e um erro de digitação não pode calar
  // o rep — na dúvida, fica no transporte antigo (que funciona).
  return allow.some((a) => a.endsWith(d) || d.endsWith(a)) ? "sparkzap" : "stevo";
}

/** Config do endpoint da ponte no Spark OS. Sem isso, SparkZap não sai do chão. */
export function sparkZapEndpoint(): { url: string; token: string } | null {
  const url = process.env.SPARK_OS_WA_URL?.trim();
  const token = process.env.SPARK_OS_WA_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Chave-mestra do envio da resposta ao rep — vale pros DOIS transportes.
 *
 * Item 3 do scan 2026-07-28: essa chave se chamava `STEVO_SEND_ENABLED`. Com o
 * cutover isso virou uma armadilha de nome: quem desligasse a env achando que
 * estava "tirando o Stevo" calaria o SparkZap junto, e o SparkBot ficaria mudo
 * sem ninguém entender o porquê. O nome novo é `SPARKBOT_SEND_ENABLED`.
 *
 * O nome antigo continua sendo lido (retrocompat) — a env velha ainda está em
 * prod e trocar código e env no mesmo deploy é como se perde o bot no ar.
 * Quando `SPARKBOT_SEND_ENABLED` estiver setada na Vercel, a antiga pode sair.
 */
export function isSparkbotSendEnabled(): boolean {
  const novo = process.env.SPARKBOT_SEND_ENABLED?.trim();
  if (novo) return /^(1|true|yes)$/i.test(novo);
  return /^(1|true|yes)$/i.test(process.env.STEVO_SEND_ENABLED?.trim() || "");
}
