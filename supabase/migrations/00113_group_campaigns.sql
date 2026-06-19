-- =============================================================================
-- Migration 00113: group_campaigns — campanhas em GRUPOS de WhatsApp (Pedro 2026-06-18)
-- =============================================================================
-- Caso Matheus Curty ("postar 2 posts nesses grupos às 7:30am"): o SparkBot ganha
-- a capacidade de disparar mensagens em GRUPOS de WhatsApp via API do Stevo,
-- reusando o motor de Bulk V2 (mesmas tabelas bulk_message_*, mesmo claim atômico,
-- mesmo cron, mesmo tripé pausa/retoma/cancela). Esta migration é ADITIVA.
--
-- Decisões de schema (ancoradas no mapa de superfícies 2026-06-18):
--  (1) target_type é ORTOGONAL a delivery_channel. Grupo NÃO é um canal novo —
--      continua 'whatsapp_web_sms' (rota Stevo). target_type='groups' só muda o
--      DESTINO (JID de grupo em vez de contactId GHL). NÃO mexemos no CHECK de
--      delivery_channel (evita DROP/ADD de constraint em prod).
--  (2) 1 campanha de grupo = 1 job target_type='groups' + N recipients (1 por
--      grupo). recipient.contact_id recebe o JID do grupo (coluna text NOT NULL,
--      sem FK a contacts) → satisfaz UNIQUE(job_id,contact_id) naturalmente
--      (1 grupo 1x por job). target_jid/group_name são explícitos pro runner e UI.
--  (3) Caso "2 posts/dia" = campanha RECORRENTE (recurring_campaigns). Cada
--      ocorrência do cron vira um job filho NOVO (job_id diferente) → o mesmo
--      grupo reaparece dia após dia sem colidir com a UNIQUE. recurring_campaigns
--      ganha target_type + group_targets (snapshot dos grupos-alvo).
--  (4) Gate multi-tenant anti-ban: stevo_instances.kind. Campanha de grupo SÓ
--      roda em instância 'dedicated'. Default 'shared' (a instância sparkbot
--      compartilhada que carrega o DM de TODOS os reps) → recusada por padrão.
--      Isola o risco de ban ao número dedicado, nunca derruba o DM de todos.
--  (5) Terms & Segurança PARTE 2 (consentimento de campanha de grupo, com risco
--      de ban explícito): rep_identities ganha 3 timestamps espelhando o gate de
--      termos da Parte 1. _pending_at = o rep tentou agendar e está no fluxo de
--      aceite; _accepted_at / _rejected_at = resolução. REJECT da Parte 2 NÃO
--      silencia o SparkBot (diferente da Parte 1) — só bloqueia campanha de grupo.
--
-- Flag de rollout: GROUP_CAMPAIGNS_ENABLED (default OFF / log-first). Nada dispara
-- em prod até ligar e validar 1 caso real (disciplina do projeto).
-- Aplicado em prod via MCP — arquivo sempre criado (convenção CLAUDE.md).
-- =============================================================================

-- (1)+(2) bulk_message_jobs: alvo da campanha (contatos vs grupos) -------------
ALTER TABLE public.bulk_message_jobs
  ADD COLUMN IF NOT EXISTS target_type text NOT NULL DEFAULT 'contacts'
    CHECK (target_type IN ('contacts', 'groups'));

COMMENT ON COLUMN public.bulk_message_jobs.target_type IS
  'Destino do disparo: contacts (contactId GHL via /conversations/messages) | groups (JID de grupo via Stevo /send/text). Ortogonal a delivery_channel.';

-- bulk_message_recipients: JID + nome do grupo (NULL pra campanha de contatos) -
ALTER TABLE public.bulk_message_recipients
  ADD COLUMN IF NOT EXISTS target_jid text,
  ADD COLUMN IF NOT EXISTS group_name text;

COMMENT ON COLUMN public.bulk_message_recipients.target_jid IS
  'JID do grupo (xxx@g.us) quando o job é target_type=groups. NULL pra contatos. O runner usa target_jid ?? contact_id pra rotear o envio ao grupo.';
COMMENT ON COLUMN public.bulk_message_recipients.group_name IS
  'Nome humano do grupo (snapshot do momento do agendamento). Só pra UI/audit.';

-- Índice pra listar recipients de grupo de um job sem varrer os de contato.
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_group
  ON public.bulk_message_recipients (job_id)
  WHERE target_jid IS NOT NULL;

-- (3) recurring_campaigns: recorrência de grupo (caso Matheus 2 posts/dia) -----
ALTER TABLE public.recurring_campaigns
  ADD COLUMN IF NOT EXISTS target_type text NOT NULL DEFAULT 'contacts'
    CHECK (target_type IN ('contacts', 'groups')),
  ADD COLUMN IF NOT EXISTS group_targets jsonb;

COMMENT ON COLUMN public.recurring_campaigns.target_type IS
  'contacts (filtra contatos por tag a cada ocorrência) | groups (posta nos grupos de group_targets).';
COMMENT ON COLUMN public.recurring_campaigns.group_targets IS
  'Snapshot dos grupos-alvo quando target_type=groups: [{ "jid": "xxx@g.us", "name": "..." }]. NULL pra contatos.';

-- (4) stevo_instances.kind: gate de instância dedicada (anti-ban sistêmico) ----
ALTER TABLE public.stevo_instances
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'shared'
    CHECK (kind IN ('shared', 'dedicated'));

COMMENT ON COLUMN public.stevo_instances.kind IS
  'shared = número compartilhado que carrega o DM de TODOS os reps (NUNCA usar pra campanha de grupo — ban derrubaria todo mundo). dedicated = número provisionado só pra um rep/location (servidor dedicado). Campanha de grupo SÓ roda em dedicated.';

-- (5) rep_identities: Terms & Segurança PARTE 2 (campanha de grupo) ------------
ALTER TABLE public.rep_identities
  ADD COLUMN IF NOT EXISTS group_campaign_terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS group_campaign_terms_rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS group_campaign_terms_pending_at timestamptz;

COMMENT ON COLUMN public.rep_identities.group_campaign_terms_accepted_at IS
  'Parte 2 dos termos (campanha de grupo) aceita. NULL = ainda não liberou campanha de grupo. Diferente de terms_accepted_at (Parte 1, uso geral do SparkBot).';
COMMENT ON COLUMN public.rep_identities.group_campaign_terms_rejected_at IS
  'Parte 2 recusada. NÃO silencia o SparkBot (só bloqueia campanha de grupo). Admin reseta com UPDATE ... SET group_campaign_terms_rejected_at = NULL.';
COMMENT ON COLUMN public.rep_identities.group_campaign_terms_pending_at IS
  'Rep tentou agendar campanha de grupo e está no fluxo de aceite da Parte 2. O processor (pré-LLM) captura accept/reject determinístico enquanto este timestamp estiver setado.';
