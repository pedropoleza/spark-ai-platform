-- H111 (2026-11-03, Alves Cury): entrada pela automação POR ETIQUETA.
--
-- Com `entry_by_automation` ligado, a IA cala na 1ª mensagem do lead e não abre
-- conversa por gatilho (H90): quem abre é o workflow do Spark Leads. Na conta da
-- Márcia todo lead novo passa pela saudação do workflow. No Bruno (recrutamento
-- da Alves Cury) não: só o lead do formulário de carreira é saudado pela
-- automação, com o link da landing que mede o vídeo. Quem chega por anúncio
-- direto no WhatsApp, pelo Instagram, ou é ligado à mão pelo campo "AI" continua
-- sendo aberto pela IA.
--
-- Esta coluna restringe a regra: preenchida, o silêncio da 1ª mensagem e o
-- descarte do turno proativo valem SÓ pro contato que tem essa etiqueta (o
-- workflow põe a etiqueta antes de ligar a IA). NULL = vale pra todos, como hoje.
-- Aditiva e nullable: nenhum agente muda até alguém preencher.

alter table public.agent_configs
  add column if not exists entry_by_automation_tag text;

comment on column public.agent_configs.entry_by_automation_tag is
  'H111: com entry_by_automation, a entrada pela automação vale só pro contato com esta etiqueta. NULL = todos.';
