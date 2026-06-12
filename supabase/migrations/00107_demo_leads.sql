-- ============================================================================
-- 00107: demo_leads — captura do quiosque /demo (demo de convenção)
-- ============================================================================
-- Motivação (refactor demo 2026-06-11): o form do quiosque postava pra
-- /api/demo/lead, endpoint que NUNCA existiu (pendência D5 do commit e969491).
-- O fetch era best-effort com catch vazio → todo lead do estande era perdido
-- silenciosamente. Esta tabela + o endpoint fecham o buraco.
--
-- Acesso: RLS ligado SEM policy = nega anon/authenticated; só o service role
-- (endpoint server-side) lê/escreve. Importação pro Spark Leads:
-- scripts/import-demo-leads.ts (preenche imported_at/import_ref).

create table if not exists demo_leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  whatsapp_raw text not null,        -- como digitado no quiosque: "(11) 99000-0000"
  whatsapp_e164 text,                -- normalizado BR-aware: "+5511990000000"
  agencia text not null,
  source text not null default 'kiosk-convencao-2026',
  queued_at timestamptz,             -- quando entrou na fila offline do tablet
  created_at timestamptz not null default now(),
  imported_at timestamptz,           -- quando virou contato no Spark Leads
  import_ref text                    -- contact_id criado na importação
);

create index if not exists idx_demo_leads_created_at on demo_leads (created_at desc);
create index if not exists idx_demo_leads_pending_import on demo_leads (created_at) where imported_at is null;

alter table demo_leads enable row level security;
