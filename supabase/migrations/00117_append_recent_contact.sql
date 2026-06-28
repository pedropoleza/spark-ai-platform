-- =====================================================================
-- 00117 — RPC atômica append_recent_contact (follow-up H45/F10, 2026-06-27)
-- =====================================================================
-- O ring buffer rep_identities.profile.recent_contacts (H45/F10) era atualizado
-- por um read-modify-write em `recordRecentContact` (active-contact.ts):
--   SELECT profile  →  monta o array em JS  →  UPDATE profile inteiro.
-- Dois turnos do MESMO rep processados em paralelo (rajada de mensagens caindo
-- em lambdas diferentes) carregavam o mesmo profile, cada um prependia o seu
-- contato e o segundo UPDATE sobrescrevia o primeiro → contato "some" do buffer
-- em silêncio. (Mesma classe do race que o H45 já documenta como follow-up.)
--
-- Esta função faz a MESMA lógica (dedupe por id, novo no topo, cap N preservando
-- ordem) num ÚNICO UPDATE — atômico no nível da linha, então dois chamadores
-- concorrentes serializam no lock da row em vez de se sobrescreverem.
--
-- O TS chama via supabase.rpc('append_recent_contact', ...) e mantém o caminho
-- antigo como fallback se a função não existir (staging sem esta migration).
CREATE OR REPLACE FUNCTION public.append_recent_contact(
  p_rep_id uuid,
  p_entry jsonb,
  p_cap integer DEFAULT 5
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.rep_identities r
  SET profile = jsonb_set(
    COALESCE(r.profile, '{}'::jsonb),
    '{recent_contacts}',
    COALESCE(
      (
        SELECT jsonb_agg(elem ORDER BY ord, rn)
        FROM (
          SELECT elem, ord, rn
          FROM (
            -- novo entry no topo (ord 0); existentes preservam a ordem original
            -- (ord 1, rn = posição), exceto o de MESMO id (dedupe) que é descartado
            -- aqui pra reentrar no topo já atualizado.
            SELECT p_entry AS elem, 0 AS ord, 0::bigint AS rn
            UNION ALL
            SELECT e.elem, 1 AS ord, e.rn
            FROM jsonb_array_elements(COALESCE(r.profile->'recent_contacts', '[]'::jsonb))
                 WITH ORDINALITY AS e(elem, rn)
            WHERE e.elem->>'id' IS DISTINCT FROM p_entry->>'id'
          ) merged
          ORDER BY ord, rn
          LIMIT GREATEST(COALESCE(p_cap, 5), 1)
        ) capped
      ),
      '[]'::jsonb
    )
  )
  WHERE r.id = p_rep_id;
$$;

COMMENT ON FUNCTION public.append_recent_contact(uuid, jsonb, integer) IS
  'H45/F10: append atômico ao ring buffer profile.recent_contacts (dedupe por id, novo no topo, cap N). Evita o race do read-modify-write em recordRecentContact.';
