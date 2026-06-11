-- =============================================
-- 00106_dispatch_claim_cooldown0_race
--
-- NB-10 (review 2026-06-10): try_claim_dispatch_slot (00033) NÃO serializa
-- regras com cooldown_minutes <= 0. A branch `IF p_cooldown_minutes <= 0`
-- fazia INSERT .. ON CONFLICT DO UPDATE SEM cláusula WHERE e SEMPRE
-- `RETURNING id` — logo, duas chamadas concorrentes de dispatchRule pro MESMO
-- (rep_id, rule_id, target_id) recebiam AMBAS um id não-nulo e AMBAS seguiam
-- pra LLM + envio. O claim atômico (que serializa via WHERE last_fired_at <
-- cutoff) só protegia cooldown > 0.
--
-- Regras afetadas (account-assistant/proactive/system-rules.ts): "Deal
-- fechado" (deal_won) e "Novo lead atribuído" (contact_assigned_to_rep) —
-- ambas cooldown_minutes: 0 ("cada deal merece ser comemorado").
--
-- Por que é LATENTE hoje (não vivo): nenhum caminho de produção wireia esses
-- eventos pro dispatchRule ainda. event-router.ts roteia OPPORTUNITY*/CONTACT*
-- pra "Etapa 4 (só log)"; processReactivePolling (cron sparkbot-proactive) só
-- implementa post_meeting; o caminho de teste (simulate-rule) usa
-- forceFire=true (branch upsert separado no dispatcher.ts, não passa por esta
-- função). Vira bug REAL no instante em que deal_won / novo-lead forem ligados
-- ao dispatchRule (o TODO explícito da Etapa 4). Impacto quando live: msg
-- proativa duplicada pro rep ("parabéns pelo deal" 2x, "novo lead" 2x) +
-- double-charge de tokens LLM. Blast radius = 1 (rep, rule, target).
-- Rep-facing, sem vazamento de dado.
--
-- Fix: unifica as duas branches num único upsert guardado. Para cooldown <= 0
-- usa um PISO anti-race de 2s (em vez de "sempre permite"): o cutoff vira
-- now() - 2s, então a 2ª chamada concorrente vê o last_fired_at recém-gravado
-- da 1ª, o WHERE falha, o UPDATE é pulado e RETURNING devolve vazio (NULL).
-- now() = transaction_timestamp() do MESMO relógio do servidor DB pras duas
-- tx (sem skew cross-máquina); o piso só precisa exceder o gap entre duas
-- tentativas duplicadas (ms pra lambdas concorrentes) — 2s é folgado.
-- NÃO é cooldown de produto: cada (rep, rule, target) DISTINTO fura o piso
-- (deal_won usa opp_id, contact_assigned usa contact_id como target → cada
-- deal/lead continua sendo comemorado 1x). Disparar o MESMO target 2x dentro
-- de 2s é, por definição, duplicata.
--
-- Validação: scripts/test-dispatch-claim-race.ts — 2 chamadas paralelas pro
-- mesmo (rep, rule, target) com cooldown 0 → exatamente 1 id não-nulo; targets
-- distintos → ambos ganham; regressão cooldown>0 segue serializando.
--
-- SECURITY DEFINER + search_path fixo (pg_temp por último, anti-shadow) +
-- EXECUTE travado em service_role: mesma postura defense-in-depth da
-- 00088/00100 (a função 00033 PRECEDE a convenção; trazemos ao padrão ao
-- reescrever). Caller real é sempre o dispatcher via service_role
-- (createAdminClient) — anon/authenticated nunca chamam. Aditivo, idempotente
-- (CREATE OR REPLACE mantém a identidade da função — mesma assinatura).
-- Aplicado em prod via MCP — arquivo sempre criado (convenção).
-- =============================================

CREATE OR REPLACE FUNCTION public.try_claim_dispatch_slot(
  p_rep_id            UUID,
  p_rule_id           UUID,
  p_target_id         TEXT,
  p_cooldown_minutes  INT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id     UUID;
  v_cutoff TIMESTAMPTZ;
BEGIN
  -- NB-10 (review 2026-06-10): cooldown <= 0 não é mais "sempre permite" sem
  -- guarda. Aplica um PISO anti-race de 2s pra que duas chamadas concorrentes
  -- pro mesmo (rep, rule, target) não ganhem AMBAS o claim (double dispatch).
  -- Targets distintos furam o piso normalmente. Ver header da migration.
  IF p_cooldown_minutes <= 0 THEN
    v_cutoff := now() - interval '2 seconds';
  ELSE
    v_cutoff := now() - make_interval(mins => p_cooldown_minutes);
  END IF;

  -- INSERT se não existe (1ª chamada ganha via RETURNING do INSERT). Se existe,
  -- o UPDATE só ganha o claim quando last_fired_at < cutoff (cooldown/piso
  -- expirou). Match NULL-safe em target_id via UNIQUE NULLS NOT DISTINCT
  -- (constraint assistant_alert_state_dispatch_key — C5, migration 00040).
  INSERT INTO assistant_alert_state (rep_id, rule_id, target_id, last_fired_at, status)
  VALUES (p_rep_id, p_rule_id, p_target_id, now(), 'running')
  ON CONFLICT (rep_id, rule_id, target_id)
  DO UPDATE SET last_fired_at = now(), status = 'running'
  WHERE assistant_alert_state.last_fired_at < v_cutoff
  RETURNING id INTO v_id;

  -- v_id NULL = UPDATE pulado (claim NÃO ganho — já disparou dentro da janela).
  RETURN v_id;
END;
$$;

-- Defense-in-depth (igual 00088/00100): só service_role/postgres acessam dados
-- no runtime; anon/authenticated nunca chamam o claim.
REVOKE ALL ON FUNCTION public.try_claim_dispatch_slot(UUID, UUID, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_claim_dispatch_slot(UUID, UUID, TEXT, INT) TO service_role;

COMMENT ON FUNCTION public.try_claim_dispatch_slot(UUID, UUID, TEXT, INT) IS
  'NB-10 (2026-06-10): claim atômico de slot de dispatch proativo. Serializa chamadas concorrentes pro mesmo (rep, rule, target) INCLUSIVE com cooldown_minutes<=0 (piso anti-race de 2s, antes a branch cooldown<=0 dava upsert sem WHERE = double dispatch). Retorna o id do alert_state se ganhou o claim, NULL se já disparou dentro da janela.';
