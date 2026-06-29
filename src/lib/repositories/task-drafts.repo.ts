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
  "id, rep_id, location_id, agent_id, kind, status, title, meta, materialized_job_id, materialized_count, materialized_at, saved_at, created_at, updated_at";
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

/**
 * Rascunho mais recente do rep de QUALQUER status (exceto cancelled) — pra LEITURA
 * (show_draft / get_task_progress) que precisa enxergar o fluxo já materializado.
 * Mutators NÃO usam isto (eles exigem ativo via getActiveDraftForRep).
 */
export async function getLatestDraftForRep(
  repId: string,
  kind?: TaskKind,
): Promise<TaskDraft | null> {
  const db = createAdminClient();
  let q = db
    .from("task_drafts")
    .select(DRAFT_COLS)
    .eq("rep_id", repId)
    .neq("status", "cancelled")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.maybeSingle();
  if (error) {
    console.warn("[task-drafts] getLatestDraftForRep falhou:", error.message);
    return null;
  }
  return (data as TaskDraft) ?? null;
}

// --- Biblioteca de fluxos salvos (00117) -----------------------------------

/** 1 fluxo salvo + contagem de passos (pra list_flows / find_flow). */
export interface SavedFlowRow {
  draft_id: string;
  title: string | null;
  step_count: number;
  saved_at: string;
  created_at: string;
}

/**
 * Marca um draft como template salvo na biblioteca do rep (set saved_at) e,
 * opcionalmente, renomeia (title). Escopo no rep (não salva draft de outro).
 * Checa affected: 0 = não casou (id errado ou de outro rep) → caller não reporta sucesso.
 */
export async function markFlowSaved(
  draftId: string,
  repId: string,
  name?: string | null,
): Promise<{ ok: boolean; affected: number }> {
  const db = createAdminClient();
  const patch: Record<string, unknown> = { saved_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (name !== undefined && name !== null && name.trim()) patch.title = name.trim();
  const { data, error } = await db
    .from("task_drafts")
    .update(patch)
    .eq("id", draftId)
    .eq("rep_id", repId)
    .select("id");
  if (error) {
    console.warn("[task-drafts] markFlowSaved falhou:", error.message);
    return { ok: false, affected: 0 };
  }
  return { ok: true, affected: data?.length ?? 0 };
}

/** Lista os fluxos SALVOS do rep (saved_at not null) + contagem de passos de cada. */
export async function listSavedFlows(repId: string): Promise<SavedFlowRow[]> {
  const db = createAdminClient();
  const { data: drafts, error } = await db
    .from("task_drafts")
    .select("id, title, saved_at, created_at")
    .eq("rep_id", repId)
    .not("saved_at", "is", null)
    .order("saved_at", { ascending: false });
  if (error) {
    console.warn("[task-drafts] listSavedFlows falhou:", error.message);
    return [];
  }
  const rows = (drafts as Array<{ id: string; title: string | null; saved_at: string; created_at: string }>) ?? [];
  if (rows.length === 0) return [];

  // Contagem de passos por draft num único fetch (rep tem poucos fluxos × ≤60 passos).
  const ids = rows.map((r) => r.id);
  const { data: steps } = await db.from("draft_steps").select("draft_id").in("draft_id", ids);
  const counts = new Map<string, number>();
  for (const s of (steps as Array<{ draft_id: string }>) ?? []) {
    counts.set(s.draft_id, (counts.get(s.draft_id) ?? 0) + 1);
  }
  return rows.map((r) => ({
    draft_id: r.id,
    title: r.title,
    step_count: counts.get(r.id) ?? 0,
    saved_at: r.saved_at,
    created_at: r.created_at,
  }));
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
