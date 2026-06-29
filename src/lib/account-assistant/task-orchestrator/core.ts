/**
 * Service do Motor de Orquestração de Tarefas (Pedro 2026-06-20).
 * Plano: _planning/jussara-sparkbot/EXECUCAO.md (F1).
 *
 * É AQUI que mora a validação determinística + o snapshot canônico. As tools
 * (tools/task-orchestrator.ts) são wrappers finos que chamam estas funções.
 *
 * Regra anti-alucinação: toda mutação VALIDA, persiste, e devolve o ESTADO REAL
 * recomputado (buildSnapshot do DB). Mutação inválida devolve o estado INALTERADO
 * + erros estruturados — NUNCA "sucesso" falso. O bot só afirma o que vier no snapshot.
 */
import {
  createDraft,
  getDraftWithSteps,
  getActiveDraftForRep,
  getLatestDraftForRep,
  insertStep,
  updateStep,
  deleteStep,
  countSteps,
  insertTaskEvent,
  updateDraft,
} from "@/lib/repositories/task-drafts.repo";
import type { DraftStepInput, DraftWithSteps } from "./types";
import {
  MAX_DRAFT_STEPS,
  isValidOffsetDays,
  isValidSendTime,
  DEFAULT_SEND_TIME,
  type TaskKind,
} from "./config";

// --- Snapshot canônico (o que o bot relê / parrota) ------------------------

export interface SnapshotStep {
  /** Índice 1-based na ordem canônica (offset_days, intra_day, position). */
  n: number;
  day_label: string; // "Dia 0", "Dia 5"
  offset_days: number;
  send_time: string; // efetiva (default se null)
  intra_day_delay_s: number;
  message_text: string;
  has_media: boolean;
  media_url: string | null;
  media_type: string | null;
  condition: string | null;
}

export interface DraftSnapshot {
  draft_id: string;
  kind: TaskKind;
  status: string;
  title: string | null;
  target: { contact_id?: string; contact_name?: string; contact_phone?: string; tag?: string };
  step_count: number;
  cap: number;
  steps: SnapshotStep[];
  whats_missing: string[];
}

/** Monta o snapshot estruturado a partir do estado REAL do DB. */
export function buildSnapshot(dws: DraftWithSteps): DraftSnapshot {
  const meta = (dws.draft.meta || {}) as Record<string, unknown>;
  const steps: SnapshotStep[] = dws.steps.map((s, i) => ({
    n: i + 1,
    day_label: `Dia ${s.offset_days}`,
    offset_days: s.offset_days,
    send_time: s.send_time || DEFAULT_SEND_TIME,
    intra_day_delay_s: s.intra_day_delay_s,
    message_text: s.message_text,
    has_media: !!s.media_url,
    media_url: s.media_url,
    media_type: s.media_type,
    condition: s.send_condition,
  }));

  const whatsMissing: string[] = [];
  if (!meta.contact_id && !meta.tag) {
    whatsMissing.push("falta o ALVO: pra qual contato (ou tag) esse fluxo vai. Pergunte ao rep e use set_task_meta.");
  }
  if (steps.length === 0) {
    whatsMissing.push("o fluxo ainda não tem nenhum passo. Use add_step.");
  }
  steps.forEach((s) => {
    if (!s.message_text.trim() && !s.has_media) {
      whatsMissing.push(`o Passo ${s.n} (${s.day_label}) está sem texto E sem mídia.`);
    }
  });

  return {
    draft_id: dws.draft.id,
    kind: dws.draft.kind,
    status: dws.draft.status,
    title: dws.draft.title,
    target: {
      contact_id: meta.contact_id as string | undefined,
      contact_name: meta.contact_name as string | undefined,
      contact_phone: meta.contact_phone as string | undefined,
      tag: meta.tag as string | undefined,
    },
    step_count: steps.length,
    cap: MAX_DRAFT_STEPS,
    steps,
    whats_missing: whatsMissing,
  };
}

// --- Resolução do rascunho ativo -------------------------------------------

/**
 * Resolve o draft alvo: o `draftId` explícito, ou o rascunho ATIVO mais recente
 * do rep (pra o LLM não precisar carregar o id entre turnos). null se nenhum.
 */
export async function resolveDraft(
  repId: string,
  draftId: string | undefined,
): Promise<DraftWithSteps | null> {
  if (draftId) {
    // IDOR guard (review 2026-06-21): draft_id EXPLÍCITO não pode mutar/ler draft
    // de OUTRO rep. getDraftWithSteps busca só por id — filtra o dono aqui.
    const dws = await getDraftWithSteps(draftId);
    return dws && dws.draft.rep_id === repId ? dws : null;
  }
  const active = await getActiveDraftForRep(repId);
  if (!active) return null;
  return getDraftWithSteps(active.id);
}

/**
 * Como resolveDraft mas inclui rascunhos já MATERIALIZADOS — pra LEITURA
 * (show_draft / get_task_progress) depois do disparo. Os mutators continuam
 * usando resolveDraft (só ativos) pra recusar edição de fluxo já disparado.
 */
export async function resolveDraftAny(
  repId: string,
  draftId: string | undefined,
): Promise<DraftWithSteps | null> {
  if (draftId) {
    // IDOR guard (review 2026-06-21): mesmo nas LEITURAS, draft de outro rep não vaza.
    const dws = await getDraftWithSteps(draftId);
    return dws && dws.draft.rep_id === repId ? dws : null;
  }
  const latest = await getLatestDraftForRep(repId);
  if (!latest) return null;
  return getDraftWithSteps(latest.id);
}

// --- Mutações (cada uma devolve o snapshot recomputado) --------------------

export type MutationResult =
  | { ok: true; snapshot: DraftSnapshot; note?: string }
  | { ok: false; error: string };

/** Inicia um rascunho novo (ou retoma o ativo, pra não duplicar). */
export async function startDraft(
  repId: string,
  locationId: string,
  agentId: string | null,
  opts: { kind?: TaskKind; title?: string | null; target?: DraftSnapshot["target"] },
): Promise<MutationResult> {
  // Retoma se já existe um ativo do mesmo kind (anti-duplicata).
  const existing = await getActiveDraftForRep(repId, opts.kind);
  if (existing) {
    const dws = await getDraftWithSteps(existing.id);
    if (dws) return { ok: true, snapshot: buildSnapshot(dws), note: "retomado_rascunho_existente" };
  }
  const draft = await createDraft({
    rep_id: repId,
    location_id: locationId,
    agent_id: agentId,
    kind: opts.kind,
    title: opts.title ?? null,
    meta: opts.target ? { ...opts.target } : {},
  });
  if (!draft) return { ok: false, error: "Não consegui criar o rascunho da tarefa (erro no banco)." };
  await insertTaskEvent(draft.id, "draft_started", { kind: draft.kind, title: draft.title });
  const dws = await getDraftWithSteps(draft.id);
  return { ok: true, snapshot: buildSnapshot(dws!) };
}

function validateStep(input: DraftStepInput): string | null {
  if (input.offset_days !== undefined && !isValidOffsetDays(input.offset_days)) {
    return `offset_days inválido (${String(input.offset_days)}): use inteiro 0..365 (Dia 0 = imediato).`;
  }
  if (input.send_time !== undefined && input.send_time !== null && !isValidSendTime(input.send_time)) {
    return `send_time inválido (${String(input.send_time)}): use "HH:MM" 24h (ex "09:30").`;
  }
  if (
    input.intra_day_delay_s !== undefined &&
    (!Number.isInteger(input.intra_day_delay_s) || input.intra_day_delay_s < 0 || input.intra_day_delay_s > 86400)
  ) {
    return `intra_day_delay_s inválido: use inteiro 0..86400 (segundos).`;
  }
  return null;
}

/** Adiciona 1 passo (append). Valida + cap + conteúdo obrigatório (texto OU mídia). */
export async function addStep(
  repId: string,
  draftId: string | undefined,
  input: DraftStepInput,
): Promise<MutationResult> {
  const dws = await resolveDraft(repId, draftId);
  if (!dws) return { ok: false, error: "Nenhum rascunho ativo. Comece com start_task_draft." };
  if (dws.draft.status !== "building" && dws.draft.status !== "ready_for_review") {
    return { ok: false, error: `O rascunho está '${dws.draft.status}' — não dá pra editar. Comece um novo.` };
  }
  const invalid = validateStep(input);
  if (invalid) return { ok: false, error: invalid };

  const hasText = !!(input.message_text && input.message_text.trim());
  const hasMedia = !!input.media_url;
  if (!hasText && !hasMedia) {
    return { ok: false, error: "Um passo precisa de texto OU mídia. Mande pelo menos um." };
  }
  const current = await countSteps(dws.draft.id);
  if (current >= MAX_DRAFT_STEPS) {
    return { ok: false, error: `Limite de ${MAX_DRAFT_STEPS} passos atingido neste fluxo.` };
  }

  // Anti-duplicata suave (Fix caso Jussara 2026-06-29): passo com texto idêntico
  // (normalizado) a um já existente quase sempre é engano — a Jussara teve 3 passos
  // "reforçar a aplicação" iguais saindo pro lead. NÃO bloqueia (repetir pode ser
  // proposital), mas devolve uma NOTE pro bot confirmar com o rep antes de seguir.
  let dupNote: string | undefined;
  if (hasText) {
    const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
    const incoming = norm(input.message_text!);
    if (incoming && dws.steps.some((s) => norm(s.message_text) === incoming)) {
      dupNote =
        "atenção: o texto desse passo é IGUAL ao de um passo que já existe no fluxo. " +
        "Cada toque costuma variar a mensagem — confirme com o rep se a repetição é proposital antes de seguir.";
    }
  }

  const step = await insertStep(dws.draft.id, {
    offset_days: input.offset_days ?? 0,
    send_time: input.send_time ?? null,
    intra_day_delay_s: input.intra_day_delay_s ?? 0,
    message_text: input.message_text ?? "",
    media_url: input.media_url ?? null,
    media_type: input.media_type ?? null,
    send_condition: input.send_condition ?? null,
  });
  if (!step) return { ok: false, error: "Não consegui salvar o passo (erro no banco). NADA foi adicionado." };
  await insertTaskEvent(dws.draft.id, "step_added", {
    offset_days: step.offset_days,
    has_media: !!step.media_url,
    chars: step.message_text.length,
  });
  await updateDraft(dws.draft.id, {}); // bump updated_at
  const fresh = await getDraftWithSteps(dws.draft.id);
  return { ok: true, snapshot: buildSnapshot(fresh!), note: dupNote };
}

/** Mapeia step_number (1-based no snapshot) → o step real (ordem canônica). */
function stepByNumber(dws: DraftWithSteps, n: number) {
  if (!Number.isInteger(n) || n < 1 || n > dws.steps.length) return null;
  return dws.steps[n - 1];
}

/** Edita 1 passo por número (do snapshot). Patch parcial. Checa affected. */
export async function editStep(
  repId: string,
  draftId: string | undefined,
  stepNumber: number,
  patch: DraftStepInput,
): Promise<MutationResult> {
  const dws = await resolveDraft(repId, draftId);
  if (!dws) return { ok: false, error: "Nenhum rascunho ativo." };
  const target = stepByNumber(dws, stepNumber);
  if (!target) return { ok: false, error: `Passo ${stepNumber} não existe (o fluxo tem ${dws.steps.length}).` };
  const invalid = validateStep(patch);
  if (invalid) return { ok: false, error: invalid };

  const res = await updateStep(target.id, dws.draft.id, patch);
  if (!res.ok) return { ok: false, error: "Erro no banco ao editar. NADA foi alterado." };
  if (res.affected === 0) return { ok: false, error: "A edição não casou nenhum passo (estado inalterado)." };
  await insertTaskEvent(dws.draft.id, "step_edited", { step_number: stepNumber, fields: Object.keys(patch) });
  await updateDraft(dws.draft.id, {});
  const fresh = await getDraftWithSteps(dws.draft.id);
  return { ok: true, snapshot: buildSnapshot(fresh!) };
}

/** Remove 1 passo por número. */
export async function removeStep(
  repId: string,
  draftId: string | undefined,
  stepNumber: number,
): Promise<MutationResult> {
  const dws = await resolveDraft(repId, draftId);
  if (!dws) return { ok: false, error: "Nenhum rascunho ativo." };
  const target = stepByNumber(dws, stepNumber);
  if (!target) return { ok: false, error: `Passo ${stepNumber} não existe (o fluxo tem ${dws.steps.length}).` };
  const res = await deleteStep(target.id, dws.draft.id);
  if (!res.ok) return { ok: false, error: "Erro no banco ao remover. NADA foi removido." };
  if (res.affected === 0) return { ok: false, error: "Nada foi removido (passo já não existia)." };
  await insertTaskEvent(dws.draft.id, "step_removed", { step_number: stepNumber });
  await updateDraft(dws.draft.id, {});
  const fresh = await getDraftWithSteps(dws.draft.id);
  return { ok: true, snapshot: buildSnapshot(fresh!) };
}

/** Seta metadados do rascunho (alvo, título) e/ou marca ready_for_review. */
export async function setMeta(
  repId: string,
  draftId: string | undefined,
  patch: { title?: string; target?: DraftSnapshot["target"]; mark_ready?: boolean },
): Promise<MutationResult> {
  const dws = await resolveDraft(repId, draftId);
  if (!dws) return { ok: false, error: "Nenhum rascunho ativo." };
  const meta = { ...(dws.draft.meta || {}) } as Record<string, unknown>;
  if (patch.target) {
    for (const [k, v] of Object.entries(patch.target)) if (v !== undefined) meta[k] = v;
  }
  const upd: Parameters<typeof updateDraft>[1] = { meta };
  if (patch.title !== undefined) upd.title = patch.title;
  // mark_ready só se houver passos (não deixa marcar pronto um fluxo vazio).
  if (patch.mark_ready && dws.steps.length > 0 && dws.draft.status === "building") {
    upd.status = "ready_for_review";
  }
  const res = await updateDraft(dws.draft.id, upd);
  if (!res.ok) return { ok: false, error: "Erro no banco ao salvar os dados do fluxo." };
  await insertTaskEvent(dws.draft.id, "meta_updated", { fields: Object.keys(patch) });
  const fresh = await getDraftWithSteps(dws.draft.id);
  return { ok: true, snapshot: buildSnapshot(fresh!) };
}

/** Snapshot puro (read-only) do rascunho ativo/indicado. */
export async function showDraft(
  repId: string,
  draftId: string | undefined,
): Promise<{ ok: true; snapshot: DraftSnapshot } | { ok: false; error: string }> {
  // Leitura: enxerga também o fluxo já materializado (pra "me mostra o fluxo" pós-disparo).
  const dws = await resolveDraftAny(repId, draftId);
  if (!dws) {
    return { ok: false, error: "Você ainda não tem nenhum fluxo em construção. Quer começar um?" };
  }
  return { ok: true, snapshot: buildSnapshot(dws) };
}
