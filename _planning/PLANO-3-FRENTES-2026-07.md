# Plano-mestre — 3 frentes do SparkBot (2026-07-10)

> Consolidação pedida pelo Pedro: **(1) Contact Engine V2 (H47)** · **(2) Blocked Slots (H48)** · **(3) Import de planilha → disparo (H49, caso Jussara 03/07)**.
> Estudos-fonte: `_planning/sparkbot-contact-engine-v2/ESTUDO-PLANO.md` · `_planning/ghl-blocked-slots/ESTUDO-PLANO.md` · `_planning/jussara-import-planilha-2026-07/ESTUDO-PLANO.md`.
> Markers: 🤖 Claude · 👤 Pedro · 🤝 híbrido.

---

## O fio comum (por que as 3 frentes são UMA doença)

As três compartilham a mesma causa estrutural, já provada 2× no projeto (H41 orquestrador, coherence-gate): **estado que vive só na "memória" do LLM morre entre turnos e vira alucinação ou retrabalho**.
- H47: a escolha do rep na lista morre (selection_id ignorado); o contato em foco morre (herança fraca).
- H49: o ARQUIVO morre por turno; o TEXTO APROVADO morre a cada iteração (12 pessoas receberam msg errada); o job pausado morre em silêncio.
- H48 é o irmão de visibilidade: o dado existe no GHL e o bot não olha.

**Princípio das 3 frentes: todo estado de fluxo vira objeto persistente + determinístico; o LLM decide, não carrega.**

## Sequência recomendada (5 ondas, cada uma deployável)

### Onda 0 — Recovery + guard-rails imediatos (dia 1) 
- H49-F6 🤝: resolver o job pausado da Jussara (5 pendentes com texto ERRADO há 7 dias) — **decisão 👤: cancelar e redisparar com texto certo?**
- H49-F4 🤖: erro honesto da tool tabular + prompt anti-"TTL inventado" (1 arquivo, sem risco).
- H49-F5 🤖: notifier de job pausado/estagnado >24h (infra de notifier já existe).
- H47-F0 🤖: telemetria `contact_resolution` (baseline re-rodável antes de mexer).

### Onda 1 — Quick wins de código já confirmados (semana 1)
- H47-F1 🤖: 5 fixes mecânicos (F10 shape, recentContactIds morto, race JSONB, escada paralela+cache, duplicata idêntica→high).
- H48-F0 🤝: 2 probes que destravam design (block nativo vs /events; evento Google "Private" — 👤 marca 1 evento privado de teste).
- H48-F1 🤖: wrapper `listBlockedSlots` + `getCalendarContext()` + flag `BLOCKED_SLOTS_CONTEXT_ENABLED` (OFF).

### Onda 2 — Estado persistente (semanas 1-2) — o coração
- H49-F1+F2+F3 🤖: arquivo no bucket + rows/template em draft persistente + disparo por IDs do import. **Mata o caso Jussara inteiro.**
- H47-F2 🤖: tap determinístico (mapa opção→contact_id persistido) + listas legíveis (telefone na description, truncamento inteligente, dedup de labels, "ver mais").
> Sinergia real: o "draft de fluxo" do H49 e o "contrato de estado das opções" do H47 são o mesmo padrão — implementar juntos economiza e padroniza.

### Onda 3 — Contexto + visibilidade (semanas 2-3)
- H47-F3 🤖: contrato contact_id+contact_name em TODOS os proativos; ranking multi-candidato (mata sequestro de foco); TTL simétrico; refresh no turno inbound. ⚠️ Ordem interna obrigatória (ranking ANTES de novos writers).
- H48-F2+F3 🤖: briefing matinal com "🔒 compromissos do Google" + `list_appointments` completo + post_meeting filtrando blocks. Ligar flag em 1 rep 🤝 → frota.

### Onda 4 — Inteligência (semanas 3-4)
- H47-F4 🤖: score composto (email/telefone-em-texto), vCard fim-a-fim, fluxo de IMAGEM (canal nº1 do Pedro) com re-validação obrigatória, agenda como desempate de homônimos.
- H48-F4 🤖: motivo do conflito no confirm ("você tem 'X' nesse horário") + check no caminho de override.

### Onda 5 — Menos perguntas (semana 4+, gated)
- H47-F5 🤝: auto-proceed em `high` + confirm único (identidade+ação). **Só liga com telemetria da Onda 1-4 provando que duplicatas/imagem estão sob controle** — senão troca pergunta chata por ação no contato errado.
- H47-F6 / H48-F5 (opcionais): índice local de contatos · free-slots com conflitos determinísticos.

## Critérios de sucesso (medir com a telemetria da Onda 0)
| Frente | Métrica | Hoje | Meta |
|---|---|---|---|
| H47 | resolução de contato em 1 turno | 89% | ≥95% |
| H47 | msgs de fricção/dia | ~6 | <2 |
| H47 | episódios abandonados | 19% | <5% |
| H49 | reanexos de planilha por fluxo | até 12 | **0** |
| H49 | texto enviado == aprovado | falhou (12 msgs) | 100% (estrutural) |
| H49 | jobs pausados esquecidos >24h | 1 (7 dias) | 0 (notificado) |
| H48 | compromissos Google no briefing | 0% | 100% dos reps com sync |

## Decisões pendentes 👤
1. **Job da Jussara**: cancelar os 5 pendentes (texto errado) e redisparar com o texto certo? (Onda 0 — recomendo cancelar já.)
2. Go pra sequência das ondas como está, ou reordenar (ex: H48-F2 briefing antes, por ser vitrine rápida)?
3. H47-F5 (auto-proceed) fica atrás de flag própria pra decidir o timing de ligar.
