-- 00121: RPC atômico pro ring buffer recent_contacts (H47-F1, 2026-07-10).
--
-- Motivação: recordRecentContact fazia read-modify-write do profile JSONB
-- (SELECT profile → spread → UPDATE). Race conhecida do H45 (follow-up F10):
-- outros writers do profile (prefs, notified-lists dos notifiers) podiam se
-- sobrescrever mutuamente. Este RPC faz o append (dedupe por id + prepend +
-- cap) numa ÚNICA sentença SQL, tocando SÓ a chave recent_contacts.
--
-- Numeração pula 00119/00120 de propósito: já aplicados em prod via MCP
-- (rep_notes, branch feat/sparkbot-assistente-humano) — evita colisão no merge.

create or replace function public.append_recent_contact(
  p_rep_id uuid,
  p_entry jsonb,
  p_cap int default 5
) returns void
language sql
security definer
set search_path = public
as $$
  update rep_identities
  set profile = jsonb_set(
    coalesce(profile, '{}'::jsonb),
    '{recent_contacts}',
    (
      select coalesce(jsonb_agg(e), '[]'::jsonb)
      from (
        select e
        from (
          select p_entry as e, 0 as ord, 0 as idx
          union all
          select value as e, 1 as ord, ordinality::int as idx
          from jsonb_array_elements(
            coalesce(profile->'recent_contacts', '[]'::jsonb)
          ) with ordinality
          where value->>'id' is distinct from p_entry->>'id'
        ) merged
        order by ord, idx
        limit greatest(p_cap, 1)
      ) capped
    )
  )
  where id = p_rep_id;
$$;

grant execute on function public.append_recent_contact(uuid, jsonb, int) to service_role;
