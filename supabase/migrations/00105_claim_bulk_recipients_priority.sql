-- =============================================
-- 00105_claim_bulk_recipients_priority
--
-- NB-11 (review 2026-06-10): a priority queue (F4.1) do bulk-runner NÃO furava
-- fila sob backlog — exatamente o único cenário onde priority importa.
--
-- PROBLEMA: o claim atômico em `fireBulkRecipients` (bulk-message-runner.ts)
-- fazia 2 passos:
--   1. SELECT recipients pending vencidos JOIN bulk_message_jobs
--      ORDER BY scheduled_at ASC  LIMIT MAX_PER_TICK*4 (=20)   ← buffer
--   2. reordena CLIENT-SIDE por jobs.priority DESC, scheduled_at ASC, fatia 5
-- A ordenação por priority acontecia SÓ no passo 2, sobre o buffer de 20 já
-- escolhido por scheduled_at. Quando >=20 recipients de jobs de prioridade BAIXA
-- já estão vencidos (scheduled_at <= now) com timestamps antigos — ex: backlog
-- drenando após quiet_hours/working_hours ou gap de deploy — o buffer de 20 é
-- 100% consumido por eles e um job de prioridade ALTA cujos recipients têm
-- scheduled_at MAIS NOVO nunca entra na janela de candidatos. Resultado: o "fura
-- fila" (priority 70-90, documentado pro LLM em prompt-builder/bulk-messages-v2)
-- falha precisamente sob backlog. Self-healing (drena ~10/min: MAX_PER_TICK=5 a
-- cada 30s) e sem perda de dado (P3), mas derrota silenciosamente uma feature
-- paga.
--
-- POR QUE NÃO ordenar no PostgREST: `.order(col, {referencedTable:
-- 'bulk_message_jobs'})` NÃO ordena o resultado TOP-LEVEL por coluna de um embed
-- to-one (M2O) — só ordena DENTRO de um embed to-many (array). Verificado
-- empiricamente contra o PostgREST de prod (probe read-only 2026-06-10): ordenar
-- por uma coluna do embed em ASC vs DESC devolvia a MESMA ordem top-level (a
-- cláusula é silenciosamente ignorada). Logo a ordenação por priority TEM que
-- ser SQL explícito.
--
-- FIX: RPC que faz o claim num passo só, ordenando por priority no DB ANTES do
-- LIMIT, com FOR UPDATE SKIP LOCKED (fecha de quebra a race select→update que o
-- passo-2 só mitigava com o re-check `.eq('status','pending')` no UPDATE).
-- Espelha o padrão de fila do 00033 (`try_claim_dispatch_slot`). Carimba
-- claim_token + claimed_at (H37) igual o código já fazia. Retorna SETOF
-- bulk_message_recipients (todas as colunas — espelha o `.select('*')` anterior,
-- future-proof a mudanças de schema).
--
-- O runner mantém o sort client-side como tiebreaker (UPDATE..RETURNING não
-- garante ordem) e cai num caminho LEGADO se a RPC ainda não existir (gap de
-- deploy: código novo no Vercel + migration ainda não aplicada via MCP) —
-- detecta PGRST202 e usa o select+sort com buffer maior. Nunca pior que hoje.
--
-- SECURITY DEFINER + search_path fixo (pg_temp por último, anti-shadow) +
-- EXECUTE travado em service_role: mesma postura defense-in-depth das 00088/
-- 00100 (anon é dead code; runtime/cron rodam como service_role/postgres).
-- Aditivo, idempotente. Aplicado em prod via MCP — arquivo sempre criado
-- (convenção).
-- =============================================

CREATE OR REPLACE FUNCTION public.claim_bulk_recipients(
  p_limit       INT,
  p_claim_token UUID
) RETURNS SETOF bulk_message_recipients
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Padrão fila atômica: trava+seleciona os top-N por priority no MESMO
  -- statement do UPDATE. FOR UPDATE OF r trava só os recipients (não os jobs);
  -- SKIP LOCKED deixa workers concorrentes pegarem conjuntos disjuntos.
  WITH due AS (
    SELECT r.id
    FROM bulk_message_recipients r
    JOIN bulk_message_jobs j ON j.id = r.job_id
    WHERE r.status = 'pending'
      AND r.scheduled_at <= now()
      AND j.status = 'running'
    ORDER BY j.priority DESC, r.scheduled_at ASC
    LIMIT GREATEST(p_limit, 0)
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE bulk_message_recipients r
  SET status      = 'sending',
      claim_token = p_claim_token,
      claimed_at  = now()
  FROM due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

-- Defense-in-depth (igual 00088/00100): só service_role/postgres tocam dados no
-- runtime; anon não deve poder reivindicar recipients.
REVOKE ALL ON FUNCTION public.claim_bulk_recipients(INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bulk_recipients(INT, UUID) TO service_role;

COMMENT ON FUNCTION public.claim_bulk_recipients(INT, UUID) IS
  'NB-11 (2026-06-10): claim atômico priority-first do bulk-runner. ORDER BY j.priority DESC, r.scheduled_at ASC ANTES do LIMIT (fura fila mesmo sob backlog — o select+sort client-side antigo ordenava só um buffer de 20 já dominado por jobs de baixa prioridade). FOR UPDATE SKIP LOCKED fecha a race select→update. Carimba claim_token+claimed_at (H37). Retorna as rows reivindicadas (status já = sending).';
