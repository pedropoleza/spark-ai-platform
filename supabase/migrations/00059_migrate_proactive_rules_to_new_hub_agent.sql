-- 00059: Migra reactive/scheduled rules do agent_id LEGACY (c04d7bed —
-- agent do hub Notifications, agora inactive) pro agent_id NOVO
-- (483ca4eb — Sparkbot WhatsApp Hub, active).
--
-- BUG INTRODUZIDO em 00058: ao desativar o agent legacy (status=inactive),
-- getEligibleReps em cron/sparkbot-proactive retorna empty (early return
-- quando agent.status !== 'active'). Como ÚNICA rule enabled (post_meeting)
-- apontava pro agent legacy, NENHUMA rule disparou desde a migration —
-- proatividade do bot ficou completamente quebrada.
--
-- Fix: UPDATE agent_id pra o agent novo. Comportamento idêntico (rule
-- continua válida, agora em hub novo onde Stevo funciona).

UPDATE assistant_proactive_rules
SET agent_id = '483ca4eb-dd5e-4da7-bd4e-6ff1f85f240b'  -- Sparkbot WhatsApp Hub
WHERE agent_id = 'c04d7bed-abfc-4ba2-8a51-d3f4ad12b6a6';  -- legacy
