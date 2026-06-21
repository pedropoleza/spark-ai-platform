-- =====================================================================
-- 00116 — Cria o bucket de Storage 'agent-media' (Pedro 2026-06-20)
-- =====================================================================
-- A migration 00014 DOCUMENTAVA o bucket mas mandava criar "manualmente no
-- painel" — e ele nunca foi criado (SELECT em storage.buckets = vazio). Isso
-- significa que o reaction-engine `send_media` (mídia lead-facing) já dependia
-- de um bucket inexistente. O motor de orquestração (F4: gerar PDF do fluxo;
-- F5: enviar arquivo) também precisa dele. Criar via migration deixa rastreável
-- e reproduzível em staging (em vez de clique no painel).
--
-- Privado (URLs assinadas por request), 25 MB, mimes documentados na 00014.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'agent-media',
  'agent-media',
  false,
  26214400, -- 25 MB
  ARRAY['image/*', 'audio/*', 'video/*', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;
