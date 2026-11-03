-- H112 (2026-11-03, Alves Cury): agenda travada por etiqueta.
--
-- Regra do dono da conta: o Bruno só agenda o Zoom com a Taciana depois que o
-- lead assistiu 70% do vídeo da landing (etiqueta "lp carreira - 70%" ou
-- "lp carreira - video completo"). Só com o prompt, o modelo acreditava no lead
-- que dizia "já assisti" (3 de 3 no laboratório). Com esta coluna, o processor
-- não entrega horário ao modelo e zera a lista do turno quando falta a etiqueta.
--
-- Formato: {"requires_any": ["etiqueta", ...], "except_any": ["etiqueta", ...]}
--   requires_any: qualquer uma libera a agenda;
--   except_any:   qualquer uma libera mesmo sem o requisito (ex.: virada para cliente).
-- NULL ou sem requires_any = sem trava (a frota segue igual). Aditiva e nullable.

alter table public.agent_configs
  add column if not exists booking_tag_gate jsonb;

comment on column public.agent_configs.booking_tag_gate is
  'H112: {requires_any, except_any}. Sem etiqueta de requires_any (nem de except_any), o agente não recebe horário nem agenda. NULL = sem trava.';
