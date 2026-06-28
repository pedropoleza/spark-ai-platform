-- =====================================================================
-- 00118 — locations.deauthorized_at (skip-inactive no scan de rep, 2026-06-27)
-- =====================================================================
-- Follow-up de [[sparkbot-new-rep-scaling]]: a varredura de PRIMEIRA VIAGEM do
-- identifyRep (identity.ts) bate o GHL `/users/` em TODAS as ~130 locations pra
-- achar de qual sub-account é o telefone do rep novo. ~metade delas vivem
-- inativas/desautorizadas e SEMPRE erram o mint de location-token — gastam slot
-- da varredura paralela à toa (já causou o timeout de 60s que deixou onboarding
-- mudo, mesmo depois da paralelização e5a265f).
--
-- Esta coluna marca QUANDO uma location foi vista como inativa (erro persistente
-- de location-fora: "is not active" / "does not have access" / "location not
-- found" / "invalid locationId"). O scan PULA locations marcadas há < 7 dias e
-- re-tenta as mais velhas (pega reativação). Reautorizou e voltou a varrer OK →
-- o código zera a marca. NUNCA marca por 401/403 genérico (apagão de
-- company-token daria 401 em todas e mascararia o mundo como inativo).
--
-- Aditiva e nullable: o código degrada pro comportamento de hoje (varre todas)
-- se a coluna não existir, então aplicar esta migration é seguro a qualquer hora.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS deauthorized_at timestamptz;

COMMENT ON COLUMN public.locations.deauthorized_at IS
  'Skip-inactive (identity.ts): timestamp da última vez que a location errou o mint de token por estar inativa/desautorizada. NULL = ativa/nunca-falhou. Scan pula marcadas <7d e re-checa as mais velhas. Não marcar por 401/403 genérico.';
