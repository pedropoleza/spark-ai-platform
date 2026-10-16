-- H105 (2026-10-16, ticket #445 da Jussara): "equipe falou, a IA não entra".
--
-- A equipe da Jussara responde o lead pelo celular, liga, manda a ficha e marca
-- a reunião. Combinado com a conta: a IA só atende o lead que chega pelo
-- patrocinado e, depois que alguém da equipe interage, ela para de falar e não
-- entra em conversa que já teve interação da equipe. O F52 (pausa por mensagem
-- humana) não cobre isso: não pausa quando a IA ainda não falou e ignora
-- humano com mais de 72h. Código: contatoDaEquipe em
-- src/lib/queue/human-takeover.ts, lido pelo queue-processor (pausa com
-- ai_paused_reason 'auto_pause:human_message:team_contact'), pelo runner de
-- follow-up (cancela a sequência) e pelo pill do painel.
--
-- Opt-in por agente, default false: a frota segue igual até alguém ligar.
-- Aditiva: só uma coluna nova com default.

alter table public.agent_configs
  add column if not exists skip_if_team_contacted boolean not null default false;

comment on column public.agent_configs.skip_if_team_contacted is
  'H105: qualquer contato da equipe no histórico da conversa (mensagem pelo celular, inbox ou Spark OS, ou ligação) tira a IA da conversa, inclusive antes de ela falar. Default false.';
