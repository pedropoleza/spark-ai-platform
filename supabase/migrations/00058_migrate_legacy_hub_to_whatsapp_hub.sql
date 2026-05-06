-- 00058: Migra hub_location_id antigo (Notifications, instância Stevo morta)
-- pro novo (WhatsApp Hub, instância Stevo viva).
-- Pedro 2026-05-06: descobrimos que ASSISTANT_HUB_LOCATION_ID env var ainda
-- aponta pro hub legacy "Spark Leads - Notifications" (Cjc1RonkhwcnrMp3vAqt,
-- tz Asia/Taipei suspeito). O hub correto é "Sparkbot WhatsApp Hub"
-- (RBFxlEQZobaDjlF2i5px, tz America/New_York). Test de delivery confirmou:
-- mesma payload, hub novo = delivered (5s), hub antigo = "Instancia Inactive".
--
-- IMPACTO PRÉ-FIX:
--   - 35 mensagens proativas falharam silenciosamente nos últimos 7 dias
--   - 100% delivery failure rate em 12 reps distintos
--   - Bot persistia whatsapp_sent=true mas Stevo retornava failed depois
--
-- AÇÃO COMPLEMENTAR (manual, fora desta migration):
--   1. Update env var Vercel ASSISTANT_HUB_LOCATION_ID = 'RBFxlEQZobaDjlF2i5px'
--   2. Re-deploy
--
-- Esta migration migra mensagens passadas pra que `lastInbound.hub_location_id`
-- lookup em whatsapp-delivery.ts retorne o hub novo (caso env var não
-- seja a fonte primária por algum motivo de cache/fallback).

UPDATE sparkbot_messages
SET hub_location_id = 'RBFxlEQZobaDjlF2i5px'
WHERE hub_location_id = 'Cjc1RonkhwcnrMp3vAqt';

-- Update agent ativo: o agent do hub antigo vira inactive pra evitar
-- que isSparkbotHub() detecte ambos como hubs válidos. Mantém row pra
-- audit (não delete).
UPDATE agents
SET status = 'inactive'
WHERE location_id = 'Cjc1RonkhwcnrMp3vAqt'
  AND type = 'account_assistant'
  AND status = 'active';
