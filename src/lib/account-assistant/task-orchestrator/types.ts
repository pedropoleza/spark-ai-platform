/**
 * Tipos do Motor de Orquestração de Tarefas (Pedro 2026-06-20).
 * Espelham as tabelas da migration 00115 (task_drafts/draft_steps/task_events).
 */
import type { TaskKind, DraftStatus } from "./config";

/** Row de task_drafts — a TAREFA persistente (fonte da verdade entre turnos). */
export interface TaskDraft {
  id: string;
  rep_id: string;
  location_id: string;
  agent_id: string | null;
  kind: TaskKind;
  status: DraftStatus;
  title: string | null;
  /** Alvo + params (contact_id/nome/phone, timezone, cíclico, list_temperature...). */
  meta: Record<string, unknown>;
  materialized_job_id: string | null;
  materialized_count: number | null;
  materialized_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row de draft_steps — 1 passo do rascunho. */
export interface DraftStep {
  id: string;
  draft_id: string;
  position: number;
  offset_days: number;
  send_time: string | null;
  intra_day_delay_s: number;
  message_text: string;
  media_url: string | null;
  media_type: string | null;
  send_condition: string | null;
  created_at: string;
  updated_at: string;
}

/** Row de task_events — audit append-only. */
export interface TaskEvent {
  id: string;
  draft_id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
}

/** Draft + seus passos (ordenados por position) — o snapshot canônico. */
export interface DraftWithSteps {
  draft: TaskDraft;
  steps: DraftStep[];
}

/** Campos editáveis de um passo (subset usado pelos mutators). */
export type DraftStepInput = Partial<
  Pick<
    DraftStep,
    | "position"
    | "offset_days"
    | "send_time"
    | "intra_day_delay_s"
    | "message_text"
    | "media_url"
    | "media_type"
    | "send_condition"
  >
>;
