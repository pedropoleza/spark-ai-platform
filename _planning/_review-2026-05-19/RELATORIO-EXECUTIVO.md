# SparkBot — Relatório Executivo do Ultra-Review (2026-05-19)

> Análise mais completa feita até agora. 7 agentes, read-only. Fase 1 (interações:
> 2.219 msgs, 37 reps, 50 signals) + Fase 2 (codebase: 79 arquivos, 27,4k LOC).
> Detalhe em `A1/A2a/A2b/A3` (interações) e `B1/B2/B3` (código). Síntese da Fase 1 em `FASE1-SINTESE.md`.

## Veredito
| Dimensão | Nota | Leitura |
|---|---|---|
| Comportamento (quão perto de um humano) | **6,0/10** | Útil e às vezes encantador, mas não "delega e esquece". |
| Arquitetura | **6,5/10** | Ossatura boa (2 pipelines limpos, zero ciclos), mas sem camada de dados e com escopo de token cego. |
| Organização/limpeza | **5,5/10** | Arquivos gigantes, bulk triplicado, 16 strings "GHL" vazando pro rep. |

**A descoberta central:** o que derruba a confiança do rep **não é falta de capacidade nem de
liberdade agêntica** (o bot já usa 2+ tools em 58% dos runs). É **confiabilidade de execução**:
o bot afirma ter feito coisas que não fez. E isso tem **causa-raiz única e localizável no código**.

---

## 🎯 Sintoma → Causa-raiz (o coração do review)
A Fase 1 viu o sintoma; a Fase 2 achou a linha culpada. Esta é a tabela acionável:

| # | Sintoma (Fase 1) | Evidência | Causa-raiz no código (Fase 2) | Fix (direção) | Esf. |
|---|---|---|---|---|---|
| **P0-1** | **Afirma escrita sem a tool rodar** ("Nota salva" 8× com `tool_calls=[]`; reminder "agendado ✅" sem tool) | A2a, A3 (9 notas + 3 reminders + 1 opp verificados em prod) | `llm-client.ts:429-444` devolve o texto final do modelo **sem checar coerência** com os tool_calls; `processor.ts:786-819` só gera signal de auditoria (comentário "não bloqueia a resposta") | Pós-validação de coerência: se o texto afirma ação de escrita (salvar/criar/agendar/mover) e **nenhum** tool de escrita rodou com sucesso no turno → bloquear/reescrever a resposta ou forçar re-run | **M** |
| **P0-2** | **Dupla-resposta (37×)**, às vezes contraditória ("Feito" vs "não existe" em 4s) | A2b | **Race de 2 webhooks inbound concorrentes** (Stevo + WhatsApp API), `ghl_message_id` distintos, Δ=2,28ms; TOCTOU nos SELECTs de dedup + `inFlightMessages` por-lambda chaveado por id distinto (B2) | Dedup por `(rep + hash de conteúdo + janela)` **antes** do id; lock distribuído por conteúdo; silence-gate parar de anexar aviso a cada disparo | **M** |
| **P0-3** | **"Mover oportunidade" cria duplicata** | A2a, B2 (`create_opportunity`=19 vs `update_status`=2; caso Henry "Movido" via create 2×) | **Não existe tool `move_*`**; roteamento create/update/update_status ambíguo; prompt sem regra de mover (B2) | Tool/description clara de mover + regra no prompt "mover pra stage X = `update_opportunity_status`" | **S** |
| **P1-4** | **Over-confirmação (33% das msgs)**, loops, "vc eh burro?" | A1, A2a, A2b | **NÃO é o gate H8** (roda `high_only` em prod). É o **próprio modelo/prompt**. Bônus: **drift** entre default do DB (`medium_and_high`) e fallback do código (`high_only`) | Calibrar prompt pra agir em ações reversíveis/baixo risco; resolver o drift de `confirmation_mode` | **S** |
| **P1-5** | **`delete_appointment` sempre dá erro** | A3 (signal `261cabfc`) | GHL IAM "route not yet supported"; código trata o 500 como transitório e **retenta 3× inutilmente** (B1) | Detectar IAM-unsupported → parar retry + mensagem clara ao rep; avaliar endpoint alternativo | **S** |
| **P1-6** | **`get_contact_notes` 403** (location `dF2FDDZzSv715e1av4gr`) | A3 (signal `cc7c6406`) | **Escopo de token invisível ao código**: o `scope` é salvo (`token-refresher.ts:132`) mas **nunca lido/validado**; sistema 100% reativo a 403 (B1) | Ler/validar o `scope` por location; tela/diagnóstico de cobertura de escopo; alerta proativo de location sem escopo | **M** |
| **P1-7** | **Persona cede a "(sou seu criador)"** e **vaza erro 422 cru + IDs internos** ao rep | A2b (`d97a87f9`, `4f17ff5c`) | system prompt + `response-sanitizer.ts` | Hardening de persona (não mudar comportamento por claim de autoridade) + sanitizar erros antes de enviar | **S** |
| **P1-8** | **Proativo ineficaz**: nudge "Como foi a reunião?" = **0% de resposta** em 42 disparos; 59% dos reps nunca responderam | A2b | Regra proativa fixa/genérica; silence-gate agressivo | Repensar copy + timing + segmentação dos proativos; medir resposta | **M** |
| **P2-9** | **"GHL"/"GHL Smart Lists" vaza pro rep** | A2b, B3 | **16 strings LLM-facing** (9 no `prompt-builder.ts`, 7 em tool descriptions); pior: `prompt-builder.ts:205` manda dizer "GHL Smart Lists". O "no GHL" do onboarding **já foi corrigido** (`3514789`) — reps antigos viram a versão velha | Trocar as 16 strings por "Spark Leads" | **S** |
| **P2-10** | **27 tools nunca disparam** | A1 | Nenhuma inacessível; 5 sem trigger (regras proativas off desde 2026-05-05). Header de `tools/index.ts` diz "45 tools" mas há **87** | Reativar regras quando implementadas; revisar descriptions; corrigir o header | **S** |

---

## Achados estruturais (Fase 2, além dos P0/P1)
- **Sem camada de repositório** — 158 chamadas cruas a `createAdminClient()` com nomes de tabela/coluna hardcoded em ~34 arquivos; `webhook-handler.ts` (1.052 LOC) mistura transporte + dedup + billing + persistência + envio. Maior dívida de "cada coisa no seu lugar". (B1) — **L**
- **Multi-tenant pela metade** — inbound é multi-hub real, mas proativo/follow-up/admin ainda dependem da env legada `ASSISTANT_HUB_LOCATION_ID` (`reminder-runner.ts:169`, `tools/followup.ts:449`). 2º hub recebe inbound mas não proativo. (B1) — **M**
- **Fronteira GHL vazada** — 42 chamadas diretas furando `operations.ts`. (B1) — **M**
- **Bulk triplicado** — V1/V2/management = 3.632 LOC, 16 tools no registry; V1 parcialmente deprecated mas ainda registrado, vira lib de helpers do V2/management (acoplamento frágil). (B3) — **M**
- **Arquivos gigantes** — `bulk-messages.ts` 1.429, `calendar.ts` 1.363, `prompt-builder.ts` 1.153, `webhook-handler.ts` 1.052, `processor.ts` 939 — candidatos a split. (B3) — **M/L**
- **Detalhes**: colisão de nomes (2× `processor.ts`, 2× `prompt-builder.ts`); URL do pg_cron hardcoded apontando pra prod. (B1) — **S**

## Boa notícia (preservar)
- **Liberdade agêntica saudável**: 58% dos runs com 2+ tools, 18% com 4+. O loop **permite** combos — não mexer nisso. (A1, B2)
- Forças reais: leitura de CNH/policy por imagem, áudio→nota, conhecimento de underwriting/IUL/lapse, follow-ups empáticos, dedup de contato. (A2a, A2b)
- Zero dependências circulares; subdomínios novos (`filter-engine/`, `followup/`, `conversational/`) são limpos. (B1)
- Detector de alucinação já cobre ~85% dos falsos-positivos após 4 commits. (A3)

---

## Roadmap de remediação sugerido
**Onda 1 — Confiança (P0, ataca direto a adoção):** P0-1 (pós-validação de coerência) → P0-2 (dedup por conteúdo) → P0-3 (mover→update). Estas três fazem o bot **parar de mentir** e de se contradizer.
**Onda 2 — Fricção & tools quebradas (P1):** P1-4 (over-confirmação + drift) → P1-5/P1-6 (token/IAM) → P1-7 (persona/sanitização) → P1-8 (proativo).
**Onda 3 — Higiene (P2) e dívida estrutural:** strings Spark Leads, header/dead tools, bulk dedup, camada de repositório, multi-tenant.

## Índice dos relatórios
`00-PLANO.md` · `FASE1-SINTESE.md` · `A1-metricas.md` · `A2a-conversas.md` · `A2b-conversas.md` ·
`A3-signals.md` · `B1-arquitetura.md` · `B2-tools-loop.md` · `B3-organizacao.md` · **`RELATORIO-EXECUTIVO.md`** (este).
