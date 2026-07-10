-- 00122: task_drafts aceita kind 'import_bulk' (H49 Onda 2, 2026-07-10).
--
-- Post-mortem Jussara 03/07: o fluxo planilha→disparo vivia só na memória do
-- LLM + attachment por-turno → 12 reanexos e texto divergente. Agora a planilha
-- parseada (rows) + os ids importados + o último preview viram um DRAFT
-- persistente (mesmo padrão do orquestrador H41), e as tools caem pra ele
-- quando o turno não tem anexo.

alter table task_drafts drop constraint if exists task_drafts_kind_check;
alter table task_drafts add constraint task_drafts_kind_check
  check (kind in ('followup_sequence', 'file_export', 'campaign', 'import_bulk'));
