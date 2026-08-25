-- H80 (caso Marina/Sandra 2026-08-25): a janela de busca de free-slots do turno
-- lead-facing era fixa em 7 dias (queue-processor + endpoint de teste). Em agenda
-- esparsa (~2 encontros/semana, caso Marina Couto) "semana que vem" caía fora da
-- lista: a IA via 1 slot onde o calendário tinha 4 em 14d — e ou o slot-guard
-- bloqueava, ou a IA prometia callback humano ("o time te chama no WhatsApp").
-- Knob por agente; NULL = default 7 no runtime (frota intacta). Teto 31 imposto
-- no código: o free-slots do Spark Leads recusa range > 31 dias.
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS slot_window_days integer;
COMMENT ON COLUMN agent_configs.slot_window_days IS
  'Janela (dias) da busca de free-slots no turno lead-facing. NULL = 7. Máx 31 (limite da API do Spark Leads). H80.';
