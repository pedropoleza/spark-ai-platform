/**
 * Repositório do Motor de Orquestração de Tarefas (Pedro 2026-06-20).
 * Camada de DADOS pura sobre task_drafts/draft_steps/task_events (migration 00115).
 * Validação de negócio fica no service (task-orchestrator/core.ts).
 *
 * Disciplina da casa: supabase-js NÃO lança — devolve {error}. Toda função checa
 * error e conta affected (data.length) quando relevante. Nunca try/catch esperando throw.
 *
 * NOTA de design: a ORDEM canônica do fluxo é por `offset_days` (depois
 * intra_day_delay_s, depois position) — não por uma "posição" arbitrária. Por isso
 * NÃO há reorder: `position` é só uma chave de inserção monotônica (gaps OK após
 * remove). "Mover o dia 5 pro 6" = editar offset_days, não reordenar. Isso elimina
 * o shift de posições e o risco na UNIQUE(draft_id, position).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskDraft, DraftStep, DraftStepInput, DraftWithSteps } from "@/lib/account-assistant/task-orchestrator/types";
import type { TaskKind, DraftStatus } from "@/lib/account-assistant/task-orchestrator/config";

const DRAFT_COLS =
  "id, rep_id, location_id, agent_id, kind, status, title, meta, materialized_job_id, materialized_count, materialized_at, created_at, updated_at";
const STEP_COLS =
  "id, draft_id, position, offset_days, send_time, intra_day_delay_s, message_text, media_url, media_type, send_condition, created_at, updated_at";

export interface CreateDraftInput {
  rep_id: string;
  location_id: string;
  agent_id?: string | null;
  kind?: TaskKind;
  title?: string | null;
  meta?: Record<string, unknown>;
}

/** Cria um rascunho novo (status='building'). */
export async function createDraft(input: CreateDraftInput): Promise<TaskDraft | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("task_drafts")
    .insert({
      rep_id: input.rep_id,
      location_id: input.location_id,
      agent_id: input.agent_id ?? null,
      kind: input.kind ?? "followup_sequence",
      title: input.title ?? null,
      meta: input.meta ?? {},
    })
    .select(DRAFT_COLS)
    .single();
  if (error) {
    console.warn("[task-drafts] createDraft falhou:", error.message);
    return null;
  }
  return data as TaskDraft;
}

/** Busca um rascunho por id (sem os passos). */
export async function getDraft(draftId: string): Promise<TaskDraft | null> {
  const db = createAdminClient();
  const { data, error } = await db.from("task_drafts").select(DRAFT_COLS).eq("id", draftId).maybeSingle();
  if (error) {
    console.warn("[task-drafts] getDraft falhou:", error.message);
    return null;
  }
  return (data as TaskDraft) ?? null;
}

/**
 * Snapshot canônico: rascunho + passos ordenados por (offset_days, intra_day_delay_s,
 * position). É o que show_draft devolve — o bot reancora NISSO, não no transcript.
 */
export async function getDraftWithSteps(draftId: string): Promise<DraftWithSteps | null> {
  const db = createAdminClient();
  const draft = await getDraft(draftId);
  if (!draft) return null;
  const { data, error } = await db
    .from("draft_steps")
    .select(STEP_COLS)
    .eq("draft_id", draftId)
    .order("offset_days", { ascending: true })
    .order("intra_day_delay_s", { ascending: true })
    .order("position", { ascending: true });
  if (error) {
    console.warn("[task-drafts] getDraftWithSteps (steps) falhou:", error.message);
    return { draft, steps: [] };
  }
  return { draft, steps: (data as DraftStep[]) ?? [] };
}

/** Rascunho ATIVO mais recente do rep (building|ready_for_review) — pra retomar. */
export async function getActiveDraftForRep(
  repId: string,
  kind?: TaskKind,
): Promise<TaskDraft | null> {
  const db = createAdminClient();
  let q = db
    .from("task_drafts")
    .select(DRAFT_COLS)
    .eq("rep_id", repId)
    .in("status", ["building", "ready_for_review"])
    .order("updated_at", { ascending: false })
    .limit(1);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.maybeSingle();
  if (error) {
    console.warn("[task-drafts] getActiveDraftForRep falhou:", error.message);
    return null;
  }
  return (data as TaskDraft) ?? null;
}

/** Patch parcial do rascunho (status, title, meta, materialização). Checa error+affected. */
export async function updateDraft(
  draftId: string,
  patch: Partial<
    Pick<
      TaskDraft,
      "status" | "title" | "meta" | "materialized_job_id" | "materialized_count" | "materialized_at"
    >
  >,
): Promise<{ ok: boolean; affected: number }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("task_drafts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .select("id");
  if (error) {
    console.warn("[task-drafts] updateDraft falhou:", error.message);
    return { ok: false, affected: 0 };
  }
  return { ok: true, affected: data?.length ?? 0 };
}

/**
 * Transição de status com GUARD (máquina de estado): só aplica se o status atual
 * for um dos `from` esperados. Devolve affected=0 se o guard não casar (o caller
 * NÃO pode reportar sucesso). Anti-alucinação: o bot não promove status sozinho.
 */
export async function transitionDraftStatus(
  draftId: string,
  from: DraftStatus[],
  to: DraftStatus,
  extra?: Partial<Pick<TaskDraft, "materialized_job_id" | "materialized_count" | "materialized_at">>,
): Promise<{ ok: boolean; affected: number }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("task_drafts")
    .update({ status: to, ...(extra ?? {}), updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .in("status", from)
    .select("id");
  if (error) {
    console.warn("[task-drafts] transitionDraftStatus falhou:", error.message);
    return { ok: false, affected: 0 };
  }
  return { ok: true, affected: data?.length ?? 0 };
}

/** Próxima `position` monotônica (max+1; gaps OK). */
export async function nextStepPosition(draftId: string): Promise<number> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("draft_steps")
    .select("position")
    .eq("draft_id", draftId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return 1;
  return (data.position as number) + 1;
}

/** Conta passos do rascunho (pro cap defensivo). */
export async function countSteps(draftId: string): Promise<number> {
  const db = createAdminClient();
  const { count, error } = await db
    .from("draft_steps")
    .select("id", { count: "exact", head: true })
    .eq("draft_id", draftId);
  if (error) {
    console.warn("[task-drafts] countSteps falhou:", error.message);
    return 0;
  }
  return count ?? 0;
}

/** Insere 1 passo (position auto se não vier). Devolve o passo criado. */
export async function insertStep(
  draftId: string,
  input: DraftStepInput,
): Promise<DraftStep | null> {
  const db = createAdminClient();
  const position = input.position ?? (await nextStepPosition(draftId));
  const { data, error } = await db
    .from("draft_steps")
    .insert({
      draft_id: draftId,
      position,
      offset_days: input.offset_days ?? 0,
      send_time: input.send_time ?? null,
      intra_day_delay_s: input.intra_day_delay_s ?? 0,
      message_text: input.message_text ?? "",
      media_url: input.media_url ?? null,
      media_type: input.media_type ?? null,
      send_condition: input.send_condition ?? null,
    })
    .select(STEP_COLS)
    .single();
  if (error) {
    console.warn("[task-drafts] insertStep falhou:", error.message);
    return null;
  }
  return data as DraftStep;
}

/** Busca 1 passo por id, garantindo que pertence ao draft (escopo). */
export async function getStep(stepId: string, draftId: string): Promise<DraftStep | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("draft_steps")
    .select(STEP_COLS)
    .eq("id", stepId)
    .eq("draft_id", draftId)
    .maybeSingle();
  if (error) {
    console.warn("[task-drafts] getStep falhou:", error.message);
    return null;
  }
  return (data as DraftStep) ?? null;
}

/** Patch de 1 passo (escopo no draft). Checa error+affected (mutação sem efeito = aviso). */
export async function updateStep(
  stepId: string,
  draftId: string,
  patch: DraftStepInput,
): Promise<{ ok: boolean; affected: number }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("draft_steps")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", stepId)
    .eq("draft_id", draftId)
    .select("id");
  if (error) {
    console.warn("[task-drafts] updateStep falhou:", error.message);
    return { ok: false, affected: 0 };
  }
  return { ok: true, affected: data?.length ?? 0 };
}

/** Remove 1 passo (escopo no draft). Devolve affected (0 = não existia). */
export async function deleteStep(
  stepId: string,
  draftId: string,
): Promise<{ ok: boolean; affected: number }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("draft_steps")
    .delete()
    .eq("id", stepId)
    .eq("draft_id", draftId)
    .select("id");
  if (error) {
    console.warn("[task-drafts] deleteStep falhou:", error.message);
    return { ok: false, affected: 0 };
  }
  return { ok: true, affected: data?.length ?? 0 };
}

/** Audit append-only. Fire-and-forget tolerante (falha de audit não derruba a mutação). */
export async function insertTaskEvent(
  draftId: string,
  eventType: string,
  eventData: Record<string, unknown> = {},
): Promise<void> {
  const db = createAdminClient();
  const { error } = await db
    .from("task_events")
    .insert({ draft_id: draftId, event_type: eventType, event_data: eventData });
  if (error) console.warn("[task-drafts] insertTaskEvent falhou:", error.message);
}
