-- =============================================================================
-- Migration 00119 — Cache de contatos-grupo + is_group por recipient (H46)
-- Campanhas em Grupo V2 (grupos = CONTATOS GHL; ver _planning/group-campaigns-v2-contatos/).
--
-- Descoberta-chave (GET ao vivo): um grupo de WhatsApp É um contato normal no GHL —
-- o `email` carrega o JID (`<id>@g.us`), o nome termina em "GRUPO". O envio é pela
-- rota de contato (`/conversations/messages`). Não inventamos entidade nova; só
-- ensinamos o sistema a RECONHECER contatos-grupo.
--
-- (1) `group_contacts`: cache local materializado por sync. Evita pull-all do
--     filter-engine a cada turno (cap defensivo 5000 perderia grupos dispersos
--     entre milhares de contatos) e dá o mapa nome↔contact_id↔jid pro cockpit.
--     location_id é o locationId STRING do GHL (SEM FK a `locations` — robusto a
--     location não-sincronizada; ver §2.5 do PLANO).
-- (2) `bulk_message_recipients.is_group`: o recipient É um grupo (derivado de
--     email @g.us no agendamento). O runner pula opt-out/DND/cooldown/assign pelo
--     FATO (grupo), não pelo rótulo `job.target_type` — protege campanha MISTA.
--
-- Aditiva/nullable + RLS deny-anon (padrão 00088). Aplicar via MCP + arquivo.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.group_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL,                    -- locationId STRING do GHL (não o UUID de locations)
  contact_id text NOT NULL,                     -- ID GHL do contato-grupo (endereço de ENVIO)
  jid text NOT NULL,                            -- email @g.us normalizado (lower)
  group_name text,                              -- nome amigável (o bot fala por aqui)
  tags text[],                                  -- tags do contato (targeting "meus grupos")
  member_count int,                             -- se conhecido (GHL não expõe hoje → null)
  is_archived boolean NOT NULL DEFAULT false,   -- sumiu do último sync
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_group_contacts_active
  ON public.group_contacts (location_id) WHERE NOT is_archived;
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_contacts_jid
  ON public.group_contacts (location_id, jid);

COMMENT ON TABLE public.group_contacts IS
  'H46: cache local de contatos-grupo (email @g.us) por location. Sync via syncGroupContacts. location_id = locationId STRING do GHL (sem FK a locations).';

-- is_group por recipient: decide pular opt-out/DND/cooldown/assign pelo FATO.
ALTER TABLE public.bulk_message_recipients
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bulk_message_recipients.is_group IS
  'H46: recipient é contato-grupo (email @g.us). Runner pula opt-out/DND/cooldown/ensureContactAssignedTo. NÃO confundir com job.target_type (rótulo de telemetria).';

-- Backfill defensivo (no-op em prod: H40 nunca foi ligado → 0 recipients de grupo).
UPDATE public.bulk_message_recipients SET is_group = true
  WHERE target_jid IS NOT NULL AND is_group = false;

-- RLS deny-anon (defesa em profundidade, padrão 00088). service_role/postgres bypassam.
ALTER TABLE public.group_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON public.group_contacts;
CREATE POLICY deny_anon_all ON public.group_contacts
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
