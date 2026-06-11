# Review pré-launch multi-agente — 2026-06-10

**Método:** ~26 fatias de deep-review (cada subsistema + cada grupo de tools + sweeps de segurança/confiabilidade/launch) → verificação adversarial cruzada (2 agentes por achado: 1 tentando REFUTAR + 1 medindo impacto) → crítico de cobertura → síntese.

**Números:** 81 achados brutos → **45 confirmados** (36 refutados como falso-positivo pela verificação adversarial) + 31 gaps de cobertura. 193 agentes, ~9.6M tokens.

**Readiness: 4.5/10 · NO-GO para launch FULL** (bulk + swap de app) em 2 dias · **GO CONDICIONAL** pro núcleo (SparkBot + 1 agente lead-facing 1:1, bulk/recorrentes OFF, sem swap de app sem re-consent).

> JSON cru completo (45 confirmados + 31 gaps detalhados): `raw-workflow-output.json`.

---

## Os 6 P0 — status pós-correção

| # | P0 | Status |
|---|---|---|
| 1 | **Bulk V2 mandava a msg do segmento 1 pra todos + placeholders ricos literais** (`{custom.cidade}` cru) | ✅ **FECHADO** (commit fixes 2026-06-10): runner agora lê `personalized_message` (snapshot V2 interpolado) e envia verbatim |
| 2 | **Opt-out/STOP ignorado em envio agendado/recorrente direto ao contato** (TCPA/LGPD) | ✅ **FECHADO COMPLETO**: gate `filterOutOptOutContacts` em 3 camadas — `reminder-runner.fireOutboundToContact` (disparo, cancela a task), bulk-runner (lista), e agora `send_message_to_contact` + `schedule_message_to_contact` (rep-iniciado, bloqueia + informa o rep) |
| 3 | **SSRF** no `media-processor.downloadBuffer` (webhook lead-facing fail-open) | ✅ **FECHADO**: `validateExternalUrl` antes do fetch (espelha `audio-transcriber`) |
| 4 | **Swap de `GHL_CLIENT_ID` invalida todos os refresh_tokens → 401 em massa em 24h** | 🟡 **Mitigado** pela side-task (H38 self-heal inline + `scripts/exchange-auth-code.ts`). **Processo:** re-consent de TODAS as companies ANTES do swap do env |
| 5 | **Cron de refresh sem deadman + env sem `GHL_CLIENT_ID/SECRET`** | 🟢 **Quase**: `reportError` no cron (side-task) + validação de `GHL_CLIENT_ID/SECRET` no `env.ts` no boot (ERROR audível em prod) ✅. **Falta só:** deadman no `/api/health` (flag "última atualização do token de agência > X h") |
| 6 | **pg_cron com URL/secret hardcoded + drift** (motor morre silencioso se domínio muda) | 🟡 Operacional: `SELECT * FROM cron.job` antes do cutover + parametrizar via `cron_config` |

**3 de 6 P0 fechados** nesta sessão (os que a side-task não cobriu). Os 3 restantes são todos do **cutover do app GHL** — não bloqueiam o launch do núcleo se o swap de app não for feito agora.

---

## P1 principais (vários já fechados pela side-task)

- **Anti-eco em 3 caminhos** ("IA fala 1× e emudece") → ✅ fechado: `message-sources.ts` unificou a classificação humano×IA (side-task).
- **Race F51**: webhook outbound chega antes do `execution_log` da IA commitar → IA se auto-pausa. → 🔴 aberto (gravar marcador antes do POST).
- **Lead-facing sem lock por (agent,contact)** → resposta dupla no overlap dos 2 apps + `ghl_message_id` null. → 🔴 aberto.
- **`move_opportunity` rejeita stage_id UUID com hífen** → mover etapa falha sempre. → ✅ **FECHADO** (confirmado em prod: 50+ stages da Five Star Ricos são UUID v4 c/ hífen, todos rejeitados). Fix de paridade: `move_opportunity` não roda mais `validateGhlId` no stage_id (igual create/update). Probe: `scripts/probe-stage-id-format.ts`.
- **Sequências multi-toque**: job vira "completed" no step 1 → steps 2+ nunca disparam (flag OFF). → 🔴 aberto.
- **`update_appointment`**: gate admin-only não valida dono → non-admin força slot na agenda de outro. → 🔴 aberto.
- **Tasks órfãs 'running' no reminder-runner** sem reaper (o bulk ganhou um na side-task). → 🔴 aberto.
- **Filtro de custom field manda `customFieldId` fora do filtro** → GHL ignora (422/CF errado). → 🔴 aberto.
- **Proativos via Stevo escapam do delivery-status poller** → falha de entrega invisível. → 🔴 aberto.

## Gaps de cobertura (top)
- Cutover do app GHL = cluster de SPOF (token + pg_cron + webhook dobrado).
- Prompt-injection via dados do lead injetados verbatim no prompt + tools de ação (book/move_pipeline/add_tag).
- Hub Campaigns recorrentes (cap até 50k) + ingestão do KB = paths de dinheiro/LGPD não-revisados.
- Camada SSO/IDOR + rotas write de contact-controls não-revisadas.
- Ausência de runbook de reversão do cutover + healthcheck de "motor vivo".

## Recomendação operacional
- **Núcleo**: GO condicional — SparkBot + 1 agente lead-facing 1:1, `RECURRING_CAMPAIGNS_ENABLED`/`AGENT_MOTOR_UNIFIED`/`AGENT_ENTITLEMENTS_ENFORCED` OFF.
- **Disparo em massa**: P0-1 fechado, mas validar com 1 job multi-segmento real antes de liberar amplo.
- **Swap de app GHL**: NÃO fazer sem (a) re-consent batch de todas as companies + (b) runbook + (c) smoke pós-cutover (`SELECT cron.job` + `Token Refresher.updated_at` + 1 inbound real).
