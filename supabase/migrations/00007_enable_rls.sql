-- Habilitar RLS em todas as tabelas
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_log ENABLE ROW LEVEL SECURITY;

-- Como usamos GHL SSO (nao Supabase Auth), o frontend
-- usa service_role key via API routes do Next.js.
-- service_role tem acesso total por padrao.
-- Nao precisamos de policies para anon key nessas tabelas.
