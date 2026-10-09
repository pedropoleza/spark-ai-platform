-- H103 (2026-10-09, ticket #434 da Alves Cury, aprovado pelo Marcos em 08/10):
-- remarcação depois que a equipe assume a conversa.
--
-- Quando a equipe assume (pausa por mensagem humana ou pós-agendamento), a IA
-- fica quieta. Com o agente opt-in, ela volta SÓ se o lead pedir pra remarcar
-- ou desmarcar a reunião, move a reunião na agenda e avisa a equipe. A pausa
-- nunca é desfeita. Código: src/lib/queue/remarcacao-pos-handoff.ts.
--
-- agent_configs.reschedule_after_handoff: opt-in por agente. Default false =
--   a frota inteira segue igual até alguém ligar.
-- conversation_state.reschedule_window_*: a troca de horário leva 2 turnos
--   (oferta, escolha). A janela de 24h deixa o 2º turno passar mesmo sem a
--   palavra "remarcar" ("pode ser terça"). Fecha quando a reunião é remarcada,
--   quando o lead desiste, quando a reunião some ou quando um humano volta a
--   escrever.
--
-- Aditiva: só colunas novas, nulas ou com default.

alter table public.agent_configs
  add column if not exists reschedule_after_handoff boolean not null default false;

comment on column public.agent_configs.reschedule_after_handoff is
  'H103: com a equipe no controle da conversa, a IA volta só pra remarcar/desmarcar a reunião quando o lead pede. Default false.';

alter table public.conversation_state
  add column if not exists reschedule_window_opened_at timestamptz,
  add column if not exists reschedule_window_until timestamptz;

comment on column public.conversation_state.reschedule_window_opened_at is
  'H103: quando a IA abriu a janela de remarcação nesta conversa pausada (oferta de horários).';
comment on column public.conversation_state.reschedule_window_until is
  'H103: até quando a troca de horário continua sem precisar de novo pedido. Null = fechada.';
