-- 20260702040442_sparkbot_rep_activation_view.sql
--
-- RECUPERADA DO LEDGER em 2026-08-06, não reescrita à mão. Esta migration foi
-- aplicada em produção em 2026-07-02 e o arquivo nunca chegou ao repo — o mesmo
-- vazamento que a auditoria do H70 mapeou (`_planning/auditoria-trabalho-perdido-2026-08-05.md`).
--
-- O SQL abaixo é VERBATIM o que rodou: veio de
-- `supabase_migrations.schema_migrations.statements` do projeto de produção, a
-- coluna onde o Supabase guarda o texto executado. Nada foi inferido a partir do
-- schema atual, então um staging novo reproduz prod na ordem certa.
--
-- Nome em TIMESTAMP porque é a `version` que já está no ledger de produção:
-- mudar o nome faria o `db push` tentar reaplicar. Não editar este arquivo —
-- correção vira migration NOVA.
--
-- View `sparkbot_rep_activation` — quando cada rep fez a PRIMEIRA ação de valor
-- (tool de escrita chamada pelo bot) e quantos turnos de escrita já teve. É a
-- métrica de ativação real, não de uso.

create or replace view sparkbot_rep_activation as
with write_tools as (
  select array[
    'create_appointment','create_appointments_batch','update_appointment','block_calendar_slot',
    'create_note','create_task','complete_task','update_task',
    'create_contact','update_contact',
    'schedule_reminder',
    'create_opportunity','update_opportunity','move_opportunity','update_opportunity_status',
    'add_tag','remove_tag',
    'send_message_to_contact','schedule_message',
    'commit_draft','apply_flow_to_contacts','apply_saved_flow','import_contacts_from_data',
    'create_followup_request'
  ]::text[] as names
),
agent_writes as (
  select m.rep_id, m.created_at
  from sparkbot_messages m
  cross join write_tools wt
  where m.role = 'agent'
    and m.metadata ? 'tools'
    and exists (
      select 1
      from jsonb_array_elements_text(m.metadata->'tools') as t(name)
      where t.name = any(wt.names)
    )
)
select
  ri.id                        as rep_id,
  ri.display_name,
  ri.is_internal,
  ri.active_location_id,
  ri.created_at                as rep_created_at,
  min(aw.created_at)           as first_value_action_at,
  (min(aw.created_at) is not null) as activated,
  count(aw.*)                  as write_action_turns
from rep_identities ri
left join agent_writes aw on aw.rep_id = ri.id
group by ri.id, ri.display_name, ri.is_internal, ri.active_location_id, ri.created_at;

comment on view sparkbot_rep_activation is
  'F0.4 (assistente-humano): ativacao por rep. first_value_action_at = 1a write-action do bot a pedido do rep, derivada de sparkbot_messages.metadata->tools. Observabilidade, sem runtime.';
