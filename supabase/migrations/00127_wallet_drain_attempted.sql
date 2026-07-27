-- 00127_wallet_drain_attempted.sql
--
-- Auto-drain do residual da wallet (Pedro 2026-07-27).
--
-- Contexto do deadlock: o auto-recharge da wallet SaaS do HighLevel só dispara
-- quando o SALDO cruza o limiar configurado (hoje $0 — o HL não deixa subir).
-- Mas quando a nossa cobrança de um turno excede o saldo, o GHL REJEITA a
-- cobrança INTEIRA ("Location wallet has insufficient funds") e o saldo fica
-- preso num residual (ex: $0,04) menor que um turno. Esse residual nunca cruza
-- $0 → o recharge nunca dispara → a wallet encalha e a IA fica bloqueada até
-- recarregarem na mão.
--
-- Fix (atrás da flag WALLET_AUTO_DRAIN_ENABLED, default OFF): no cron de retry,
-- drenar o residual em microcobranças descendentes ATÉ zerar a wallet → o
-- auto-recharge do HL dispara (+$10) → a cobrança real do turno é refeita e passa.
-- O GHL não expõe o saldo (endpoints 404 + o erro não traz o valor), então o
-- dreno é às cegas: cobra em passos até a cobrança real voltar a passar (=
-- recarregou) ou até um teto de dreno.
--
-- Esta coluna é o CAS que garante NO MÁXIMO 1 tentativa de dreno por EPISÓDIO
-- de bloqueio — ela é limpa junto com wallet_blocked_at quando uma cobrança
-- volta a passar (clearWalletBlock). É o teto do vazamento caso o dreno não
-- resolva (ex: se a premissa "zerar dispara o recharge" não valer no HL da conta).
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS wallet_drain_attempted_at timestamptz;

COMMENT ON COLUMN locations.wallet_drain_attempted_at IS
  'CAS do auto-drain do residual da wallet: marca que o dreno já foi tentado neste episódio de bloqueio (limpo junto com wallet_blocked_at). Garante <=1 dreno por episódio.';
