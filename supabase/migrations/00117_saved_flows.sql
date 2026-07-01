-- 00117_saved_flows.sql
--
-- Biblioteca de Fluxos Salvos (Pedro 2026-06-29). Extensão do Motor de
-- Orquestração de Tarefas (H41). Estudo: _planning/jussara-sparkbot/ESTUDO-fluxos-salvos.md
--
-- MOTIVAÇÃO (feedback da Jussara): ela quer montar um fluxo UMA vez e depois só
-- dizer "manda o fluxo de no-show pra fulano" — o bot acha o fluxo nomeado e
-- aplica. Hoje o orquestrador resolve fluxo por RECÊNCIA (último draft), sem
-- busca por NOME → pegava o fluxo errado / dizia "não encontrei, monto do zero?".
--
-- DESIGN (Opção A — mínima superfície): reusa task_drafts. Uma coluna marca o
-- draft como "template salvo na biblioteca do rep". Ortogonal ao status: um fluxo
-- pode estar 'materialized' (já disparado) E salvo. O `title` já é o nome.
-- A busca por nome reusa o scorer fuzzy do H45 (contact-resolver/normalize.ts).
-- Aplicar a N contatos reusa applyFlowToContacts (não consome o template).

ALTER TABLE task_drafts ADD COLUMN IF NOT EXISTS saved_at timestamptz;

COMMENT ON COLUMN task_drafts.saved_at IS
  'Marca o draft como template salvo na biblioteca de fluxos do rep (find_flow / apply_saved_flow). NULL = não salvo. Set = quando entrou na biblioteca.';

-- Índice parcial: a busca da biblioteca é sempre "salvos deste rep".
CREATE INDEX IF NOT EXISTS idx_task_drafts_saved
  ON task_drafts (rep_id)
  WHERE saved_at IS NOT NULL;
