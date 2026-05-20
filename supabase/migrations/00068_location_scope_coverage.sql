-- =============================================================================
-- Migration 00068: location_scope_coverage
-- Onda 2 da refatoração V2 — governança de escopo GHL (2026-05-20)
--
-- Motivação:
--   Dois bugs P0/P1 confirmados na auditoria 2026-05-19 (signals 261cabfc e
--   cc7c6406) têm a mesma raiz: o sistema descobre falhas de escopo/IAM só em
--   runtime, quando o GHL já devolveu 403 ou 5xx permanente. Não há registro
--   de quais locations têm problemas de cobertura de escopo, tornando o debug
--   manual e reativo.
--
--   Esta tabela é populada por `scope-manager.ts` (flagScopeIssue) sempre que
--   uma tool retorna code "scope_or_location" (403) ou "unsupported_endpoint"
--   (IAM 5xx). O admin pode consultar aqui quais locations precisam reconectar
--   ou aguardar suporte GHL para o endpoint.
--
-- Referência: B1-arquitetura.md §5, A3-signals.md itens 261cabfc e cc7c6406.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.location_scope_coverage (
  -- ID da location GHL (PK — uma row por location).
  location_id         text        PRIMARY KEY,
  -- ID da company GHL à qual a location pertence (pode ser NULL em edge cases).
  company_id          text,
  -- true = todos os escopos necessários parecem OK (set manualmente ou após reconexão);
  -- false = alguma ação falhou por falta de escopo ou IAM.
  covered             boolean     NOT NULL DEFAULT false,
  -- Array com os nomes das ações (tool names) que falharam por falta de escopo.
  -- Ex: ['delete_appointment', 'get_contact_notes']
  missing_scopes      text[],
  -- Última ação que falhou (para diagnóstico rápido no painel).
  last_action         text,
  -- Mensagem de erro detalhada da última falha (sanitizada, max 500 chars).
  detail              text,
  -- Timestamp da última verificação de escopo (última falha detectada).
  last_checked_at     timestamptz DEFAULT now(),
  -- Controle de auditoria.
  updated_at          timestamptz DEFAULT now()
);

-- Índice pra queries de admin filtrando por company ou por covered=false.
CREATE INDEX IF NOT EXISTS idx_location_scope_coverage_company_id
  ON public.location_scope_coverage (company_id);

CREATE INDEX IF NOT EXISTS idx_location_scope_coverage_covered
  ON public.location_scope_coverage (covered)
  WHERE covered = false;
