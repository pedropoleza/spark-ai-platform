-- =============================================================================
-- Migration 00122 — Biblioteca de mídia do REP (H46/F4)
-- Requisito #2 do Pedro: o rep manda áudio/imagem/documento PRO SparkBot, o
-- sistema GUARDA como ativo reutilizável, e isso pode ser DISPARADO nos grupos.
-- Ver _planning/group-campaigns-v2-contatos/ §5.
--
-- D1 (decisão de arquitetura): tabela NOVA `rep_media`, NÃO estende media_library
-- (que é agent_id NOT NULL, scoped por agente lead-facing; reaction-engine faz
-- .eq('agent_id', ...) — misturar fragilizaria o send_media). rep_media é chaveada
-- por rep_id. Reusa o bucket agent-media (00116) com prefixo rep-media/{rep_id}/.
--
-- D4: o asset guarda o storage_path ESTÁVEL; a signed URL é gerada NO ENVIO (TTL
-- curto), NUNCA persistida (signed URL expira → anexo quebraria dias depois).
--
-- Aditiva + RLS deny-anon (padrão 00088). Aplicar via MCP + arquivo.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.rep_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES public.rep_identities(id) ON DELETE CASCADE,
  hub_location_id text,                          -- location do hub onde foi capturada
  storage_path text NOT NULL,                    -- caminho no bucket agent-media (estável)
  mime_type text NOT NULL,
  media_kind text NOT NULL CHECK (media_kind IN ('audio', 'image', 'document')),
  size_bytes integer,
  original_name text,
  transcription text,                            -- áudio (Whisper) — pra o bot "saber" o que é
  caption_text text,                             -- imagem/doc (descrição/resumo/extração truncada)
  short_label text,                              -- rótulo curto determinístico p/ o contexto
  source text NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'web')),
  expires_at timestamptz,                        -- retenção (cron de limpeza = follow-up)
  last_used_at timestamptz,                      -- atualizado quando o asset é disparado
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rep_media_rep ON public.rep_media (rep_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rep_media_hub ON public.rep_media (hub_location_id);

COMMENT ON TABLE public.rep_media IS
  'H46: biblioteca de mídia do rep (áudio/imagem/doc enviada ao SparkBot, reutilizável nos disparos). storage_path no bucket agent-media; signed URL gerada no envio, nunca persistida.';

-- RLS deny-anon (defesa em profundidade, padrão 00088). service_role/postgres bypassam.
ALTER TABLE public.rep_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON public.rep_media;
CREATE POLICY deny_anon_all ON public.rep_media
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
