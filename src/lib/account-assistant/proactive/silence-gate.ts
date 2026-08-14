/**
 * Silence gate — protege o rep de spam quando ele para de responder.
 *
 * Lógica acordada com Pedro (2026-05-02):
 * - counter 0 (rep ativo): envia normal
 * - counter 1 → vira 2: envia COM warning leve ("É importante responder")
 * - counter 2 → vira 3: envia COM warning forte ("último aviso")
 * - counter 3+: NÃO envia, set proactive_paused_at = NOW
 *
 * Reset: qualquer inbound do rep (web ou WhatsApp) zera o counter e
 * limpa proactive_paused_at + proactive_warned_at. Implementado em
 * webhook-handler.ts (WhatsApp) e send/route.ts (Web UI).
 *
 * Detalhe importante: o "lembrete" aqui é qualquer proativo —
 * reminder, daily summary, regra proativa, etc. NÃO é só lembrete
 * literal. O Pedro foi específico: "se a pessoa está respondendo e
 * conversando, está valendo" — qualquer interação reseta.
 *
 * Pausa = silenciosa por design. Bot não manda "vou pausar agora" —
 * porque já avisou no 2º e 3º. Quarto seria spam.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// Humanização (estudo 2026-06-24, fix 1.1): o tom anterior ("⚠️ Último aviso:
// vou pausar") foi o pior ofensor de naturalidade em 7/7 segmentos — soava
// ameaça colada na saudação. Reescrito pra registro de colega; mantém a
// INTENÇÃO (avisar de leve antes de dar um tempo nos automáticos) sem o tom
// burocrático/ameaçador.
const WARN_SOFT_NOTE =
  "Opa, tô te vendo meio sumido por aqui hoje 👀 quando puder me dá um oi — " +
  "só pra eu saber que tá tudo certo.";

const WARN_HARD_NOTE =
  "Se não rolar resposta hoje eu dou um tempo nos lembretes automáticos pra " +
  "não te encher 🙏 quando quiser retomar, é só me chamar.";

export type SilenceDecision =
  | { canSend: true; warningNote: string | null; nextCounter: number; markWarned: boolean }
  | { canSend: false; reason: "already_paused" | "should_pause"; shouldSetPaused: boolean };

export interface SilenceState {
  consecutive_proactive_without_reply: number;
  proactive_paused_at: string | null;
  proactive_warned_at: string | null;
  /** 'loop_guard' = pausa de segurança dura; null/outros = pausa de silêncio. */
  proactive_pause_source?: string | null;
}

/**
 * Decide se um proativo pode ser enviado pra esse rep, com base no estado
 * de silêncio atual. NÃO mexe no DB — só decide.
 *
 * Caller deve:
 *   1. Buscar rep_identity
 *   2. Chamar checkSilenceGate(rep)
 *   3. Se canSend=true: acrescentar warningNote (se não-null) DEPOIS da msg (ver
 *      `appendSilenceNote`), enviar,
 *      depois chamar recordProactiveSent(rep_id, decision)
 *   4. Se canSend=false: pular envio. Se shouldSetPaused, pausar.
 */
export type ProactiveKind = "nudge" | "requested";

/**
 * Junta a mensagem com o recado de silêncio — o recado vem DEPOIS.
 *
 * Fix observado em prod 2026-08-05: o recado era PREFIXO, então o Resumo matinal
 * da Nathalia Barbosa abriu com "Se não rolar resposta hoje eu dou um tempo nos
 * lembretes automáticos…" e só embaixo o "☀️ Bom dia, Nathalia! Dia cheio pela
 * frente". A primeira linha do dia do rep virava uma quase-cobrança, e o
 * conteúdo que ele pediu ficava em segundo plano. Entregar primeiro, comentar
 * depois — a intenção do aviso (H43: tom de colega, não de ameaça) fica bem
 * melhor servida no rodapé.
 */
export function appendSilenceNote(message: string, note: string | null): string {
  const nota = (note || "").trim();
  if (!nota) return message;
  return `${message.trimEnd()}\n\n${nota}`;
}

export function checkSilenceGate(
  state: SilenceState,
  kind: ProactiveKind = "nudge",
): SilenceDecision {
  if (state.proactive_paused_at) {
    // 2026-08-14 (sinal de 08/08: "O rep PEDIU esse lembrete e não recebeu"):
    // a pausa de SILÊNCIO existe pra parar nudge automático em quem sumiu — mas
    // segurava também o lembrete que o rep agendou de propósito ("me lembra
    // sábado 8h"), que então ficava 3 dias em defer e expirava como failed.
    // Lembrete pedido ("requested") agora FURA a pausa de silêncio; a pausa de
    // loop_guard (IA×IA, segurança dura) continua barrando tudo.
    const pausaDura = state.proactive_pause_source === "loop_guard";
    if (kind === "requested" && !pausaDura) {
      return {
        canSend: true,
        warningNote: null,
        nextCounter: state.consecutive_proactive_without_reply ?? 0,
        markWarned: false,
      };
    }
    return { canSend: false, reason: "already_paused", shouldSetPaused: false };
  }

  const cur = state.consecutive_proactive_without_reply ?? 0;

  // Onda 1 (V2 2026-05-20): proativo SOLICITADO pelo rep (lembrete que ele
  // agendou via schedule_reminder) NUNCA ameaça nem conta como "silêncio" — ele
  // pediu pra ser lembrado, não precisa "responder". Sem warningNote, sem
  // incrementar o counter. Resolve o caso A2b (aviso/ameaça nocivo grudado num
  // lembrete do próprio rep).
  if (kind === "requested") {
    return { canSend: true, warningNote: null, nextCounter: cur, markWarned: false };
  }

  if (cur >= 3) {
    return { canSend: false, reason: "should_pause", shouldSetPaused: true };
  }

  if (cur === 2) {
    return {
      canSend: true,
      warningNote: WARN_HARD_NOTE,
      nextCounter: 3,
      markWarned: true,
    };
  }

  if (cur === 1) {
    return {
      canSend: true,
      warningNote: state.proactive_warned_at ? null : WARN_SOFT_NOTE,
      nextCounter: 2,
      markWarned: !state.proactive_warned_at,
    };
  }

  return { canSend: true, warningNote: null, nextCounter: 1, markWarned: false };
}

/**
 * Persiste o resultado do envio. Atomic-ish (uma única UPDATE).
 *
 * Se canSend=false + shouldSetPaused: marca paused_at.
 * Se canSend=true: incrementa counter (nextCounter) e opcionalmente warned_at.
 */
export async function recordProactiveSent(
  supabase: SupabaseClient,
  repId: string,
  decision: SilenceDecision,
): Promise<void> {
  if (!decision.canSend) {
    if (decision.shouldSetPaused) {
      await supabase
        .from("rep_identities")
        .update({ proactive_paused_at: new Date().toISOString() })
        .eq("id", repId);
    }
    return;
  }

  const updates: Record<string, unknown> = {
    consecutive_proactive_without_reply: decision.nextCounter,
  };
  if (decision.markWarned) {
    updates.proactive_warned_at = new Date().toISOString();
  }
  await supabase.from("rep_identities").update(updates).eq("id", repId);
}

/**
 * Helper combo: lê estado, decide, retorna decision. Caller passa pra
 * recordProactiveSent depois de tentar mandar.
 *
 * Fail-mode importante: se o rep_identity NÃO EXISTE (PGRST116 do
 * postgrest), retornamos `canSend: false` com reason='already_paused'
 * pra que NÃO mandemos proativo pra rep órfão (FK CASCADE não rolou,
 * row deletado manualmente, etc). Antes era fail-open ("assumindo rep
 * ativo") o que era um silent gate bypass — flag pelo agente de
 * validação 2026-05-02.
 *
 * Outras falhas de DB (network, timeout) seguem fail-open com warn —
 * pior caso 1 proativo extra, vs blackout total se Supabase pisca.
 */
export async function loadSilenceDecision(
  supabase: SupabaseClient,
  repId: string,
  kind: ProactiveKind = "nudge",
): Promise<SilenceDecision> {
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select(
      "consecutive_proactive_without_reply, proactive_paused_at, proactive_warned_at, proactive_pause_source",
    )
    .eq("id", repId)
    .single();

  // PGRST116 = "no rows returned" — rep órfão, recusa silenciosamente
  if (error && error.code === "PGRST116") {
    console.error(
      `[SilenceGate] rep_identity ${repId} não existe (PGRST116) — recusando proativo (orphan ref)`,
    );
    return { canSend: false, reason: "already_paused", shouldSetPaused: false };
  }

  if (error || !rep) {
    // Erro transient (network, timeout, etc.) — fail-open com warn.
    console.warn(
      "[SilenceGate] read falhou — assumindo rep ativo:",
      error?.message,
    );
    return { canSend: true, warningNote: null, nextCounter: 1, markWarned: false };
  }
  return checkSilenceGate({
    consecutive_proactive_without_reply: rep.consecutive_proactive_without_reply,
    proactive_paused_at: rep.proactive_paused_at,
    proactive_warned_at: rep.proactive_warned_at,
    proactive_pause_source: rep.proactive_pause_source ?? null,
  }, kind);
}
