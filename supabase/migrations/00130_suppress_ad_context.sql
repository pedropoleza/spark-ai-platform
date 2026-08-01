-- 00130: gate de contexto de anúncio (H61, caso Five Star/Marcia 2026-08-01)
--
-- Motivação: lead que clica em anúncio (CTWA) chega com a mensagem sintética
-- "📢 Veio de anúncio…" — o lead não digitou nada. Nas contas onde um workflow
-- de boas-vindas já faz o 1º toque (Five Star: welcome + áudio + bloco pedindo
-- dados), a IA respondia a explicação completa EM CIMA do bloco da equipe
-- (15-27 leads/dia duplicados). Com esta flag ligada, o queue-processor pula o
-- turno quando ele é 100% contexto de anúncio (audit em execution_log
-- action_type='ad_context_skip'); a IA engaja na 1ª mensagem REAL do lead.
--
-- Default false = zero mudança de comportamento pra frota.

alter table agent_configs
  add column if not exists suppress_ad_context_turn boolean not null default false;

comment on column agent_configs.suppress_ad_context_turn is
  'H61: true = turno composto só pela mensagem de contexto de anúncio (CTWA) é pulado — o workflow de welcome da conta é dono do 1º toque.';
