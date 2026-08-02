-- 00130: gate de contexto de anúncio (H61, caso Five Star/Marcia 2026-08-01)
--
-- Motivação: lead que clica em anúncio (CTWA) chega com a mensagem sintética
-- "📢 Veio de anúncio…" — o lead não digitou nada. Nas contas onde um workflow
-- de boas-vindas já faz o 1º toque (Five Star: welcome + áudio + bloco pedindo
-- dados), a IA respondia a explicação completa EM CIMA do bloco da equipe
-- (15-27 leads/dia duplicados). Com esta flag ligada, o queue-processor injeta
-- instrução determinística no turno 100% contexto-de-anúncio (audit
-- action_type='ad_context_softened'): não re-apresentar; 1 linha pro pre-fill;
-- resposta real se o lead digitou algo próprio. (v2 do review 2026-08-01 — era
-- skip duro, mas o wrapper CTWA carrega o texto REAL do lead.)
--
-- Default false = zero mudança de comportamento pra frota.

alter table agent_configs
  add column if not exists suppress_ad_context_turn boolean not null default false;

comment on column agent_configs.suppress_ad_context_turn is
  'H61 v2: true = turno composto só pelo contexto de anúncio (CTWA) roda com instrução determinística de resposta mínima (não re-apresentar; workflow de welcome é dono do 1º toque).';
