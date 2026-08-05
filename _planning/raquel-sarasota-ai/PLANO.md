# Plano de Implementação — IA de Atendimento "Raquel" (Five Rings / Sarasota)

- **Location:** `7SWfC7Zah7j3wgerHgkz` (criada 01/07, agência `TdmQMjj86Y3LgppiB96K`, fuso America/New_York, **sem agente ainda**)
- **Reunião:** Victor (Spark) × Raquel + André + Melissa — onboarding/walkthrough (2ª reunião)
- **Base:** `reuniao-onboarding-transcricao.txt` (~81 min, transcrita por whisper large-v3-turbo)
- **Status:** planejamento. Nada implementado ainda.

---

## 1. Contexto do cliente

Agência **Five Rings Financial** (National Life), mercado **brasileiro nos EUA** (Sarasota/FL). Dois braços: **seguro de vida** (clientes) + **recrutamento de agentes** (carreira).

- **Time:** Raquel (dona, opera o sistema/telas), André (sócio), Melissa (sócia — prefere o bot/chat, "não fica no computador").
- **Escala:** ~6.000 contatos (cliente + carreira), ~261 apólices ativas (força), ~200-300 em carreira. Hoje usam o CRM **"Como"** (Kommo?), 2 apps de ligação (rate-limited), e fazem **prospecção, pós-venda e indicação no manual**.
- **Migração:** import dos contatos do "Como" → automação sendo finalizada pelo Pedro (tutorial prometido "sexta").
- **Billing:** o agente de vendas apareceu como "$50 mas **já incluso** no plano" — consistente com a decisão de lead-facing incluído. Sem cobrança.

---

## 2. Escopo

**Fase 1 (agora):** UM agente lead-facing de **VENDAS/atendimento**, persona **"Raquel"** — qualifica + agenda. O de **recrutamento/carreira fica pra Fase 2** (André cuida "depois", calendário dele).

Isto é praticamente o mesmo molde do agente **Bruna (Alves Cury)** que já construímos — dá pra reusar o script de apply + o gatilho de ativação.

---

## 3. Config do agente (decidido na reunião)

| Campo | Valor | Fonte (reunião) |
|---|---|---|
| Tipo / audiência | `sales_agent`, audience `lead` | "agente de venda... o de recrutamento depois" |
| Identidade | **"Raquel"**, `identity_mode: human` | "bem humanizado mesmo, que a pessoa nem saiba que é IA" |
| Objetivo | `qualification_and_booking` | "vai qualificar e agendar" |
| Qualificação (data_fields) | nome, **data de nascimento**, **fumante (sim/não)**, **estado nos EUA** | intake de seguro de vida |
| Abertura | "Oi [nome]" (padrão) | "o padrão é oi + nome" |
| Despedida (pós-agendamento) | "Qualquer dúvida, estou por aqui" | idem |
| Personalidade | atenciosa, gentil, **experiente**, sem enrolação | "mais atenciosa, gentil, e como pessoa experiente" |
| Tom — criatividade | ~50 | "cinquentinha" |
| Tom — formalidade | ~50 (casual, mas sem abreviar tipo "vc→bc") | "menos formal, mais casual... meio termo" |
| Tom — naturalidade | ~90 (máx humano) | "o mais humano possível" |
| Tom — assertividade | ~70 (mais direto) | "mais direto" |
| Idioma | pt-BR | leads brasileiros |
| Canais | WhatsApp + Instagram | "pode colocar todos" |
| Memória do lead | **ON** (lê conversas/dados antigos) | "memória do lead vai ficar ativada" |
| Agendamento | **ON**, calendário = **Melissa Oliveira** (único) | "vai ser sempre para Melissa Oliveira" |
| Horário | full time; **opcional cap 08–22h** pra não mandar de madrugada | "talvez até 10pm pra não mandar meia-noite" |
| Pós-booking (handoff) | **SEM** "equipe entrará em contato" — transição transparente | "a gente quer que identifique que é o humano falando" |
| Follow-up | **3 toques: 10 min / 1 h / dia seguinte** (no-response) | Victor sugeriu, André topou |
| Pausa da IA | **só em mensagens específicas cadastradas** (handoff_messages), NÃO em qualquer msg humana | "o que o Pedro me ensinou... só pausa nas mensagens cadastradas" |
| KB | National Life + Brazillionaires (inclusos) + **doc da agência** (a enviar) | "biblioteca já pronta... vocês mandam a documentação" |
| Modelo | `claude-sonnet-5` (padrão lead-facing) | — |

**Nuance importante da pausa (decisão do Pedro, repetida na call):** NÃO usar `auto_pause_on_human_message` cru — se a Raquel manda 1 mensagem e esquece, o bot para de agendar. Usar **`handoff_messages`** (mensagens específicas que pausam + desativam). Isso é exatamente o padrão que já temos.

---

## 4. Ativação — "IA entra ao ser ativada" (reuso do que já construímos)

O Victor mostrou 4 modos: **mensagem, tag, campo personalizado, funil**. Pro smoke o time quer **tag `teste IA`** com os números deles.

⚠️ **Achado do caso Alves Cury (vale aqui):** o evento **`CONTACTTAGUPDATE` do Spark Leads NÃO chega ao nosso webhook** → **tag como gatilho PROATIVO não dispara** ("IA entra sozinha ao marcar a tag" não funciona por tag). O que funciona hoje:
- **Reativo por inbound:** lead escreve **e** tem a tag/campo no targeting → o agente responde. ✅ (serve pro teste: marca a tag + manda a msg de teste)
- **Proativo por CUSTOM FIELD:** o gatilho que acabei de construir (`CONTACTUPDATE` → campo AI/Ativação → agente entra sozinho). ✅

**Recomendação:** padronizar a ativação por **custom field** (ex.: campo "Ativação IA" / valor "Ativa"), igual Alves Cury — aí "marcou o campo → IA entra" funciona de verdade, e reusa o motor pronto (flags `PROACTIVE_EVENTS_ENABLED` + `PROACTIVE_EVENTS_LOCATIONS` com esta location). Pro smoke inicial, tag no targeting + msg de teste também serve.

---

## 5. Pendências 👤 (cliente / Victor) — bloqueiam a config final

1. **Doc da agência** (história, como prospectam, forma de atendimento, exemplos de conversa) → vira `knowledge_base_instructions` + `conversation_examples`. **É o que mais personaliza o agente.**
2. **Números de teste** do time (Raquel/André/Melissa) + definir a **tag/campo de ativação**.
3. **Calendário Melissa Oliveira** — confirmar o `calendar_id` + tipo de reunião (consulta inicial) + que o **link (Zoom/Meet) sai automático** do calendário (padrão dos outros).
4. **Import dos contatos do "Como"** (~6k) — automação em finalização; **não ligar a IA pra todos de uma vez** (rate/anti-ban).
5. (Fase 3) **scripts de indicação** + cadência.

---

## 6. Fases seguintes (fora do MVP da Fase 1)

- **Fase 2 — agente de RECRUTAMENTO/carreira** (André): calendário próprio, gate de work permit + virada, igual ao Bruno (Alves Cury).
- **Fase 3 — automações da plataforma** (não são o agente lead-facing, são config/automation do time):
  - **Indicação:** (a) pedir indicação recorrente ao cliente (mensal/45d, alternando script de cliente vs carreira); (b) quando o cliente manda um contato indicado → fluxo automático pra agendar. Raquel: "quero gerar leads com meus clientes."
  - **Aniversário:** mensagem automática (áudio), diferenciada por cliente/agente e gênero.
  - **Pós-venda:** ciclo 12 meses (retenção) + lembrete de anual review (com link da agenda).
  - **Mentorias M1–M5:** lembretes por nível (dia + 1h antes, com link).
  - **SparkBot** rep-facing pro time (Melissa usa mais o chat).
  - **Import de grupos** de WhatsApp (ex.: Network Sarasota) como leads.
  - **Pipelines:** ajustar níveis de carreira (District/Division Leader, M1-M4, "estudando" vs "cadastrado na Five Rings").

---

## 7. Riscos / notas

- **Duplicidade:** contato é único por telefone (bom). Ao importar grupos/listas, cuidado com quem **já é cliente/carreira** (pode já estar em pipeline) — o sistema bloqueia contato duplicado mas permite oportunidade em pipelines diferentes.
- **WhatsApp → arroba:** mudança futura (WhatsApp tirando o número em favor do @) — monitorar o import por número.
- **Escala 6k:** ativação em massa precisa de cuidado; começar com um subconjunto/teste.
- **Modelo `claude-sonnet-5`:** passa direto (prefixo `claude-`); se a conta Anthropic não tiver o ID, cai silencioso no fallback — vigiar `execution_log.ai_model_used` nas 1as msgs (mesma nota dos outros agentes).

---

## 8. Próximo passo sugerido (🤖)

Montar `scripts/apply-raquel-agent.ts` (molde do `apply-alves-cury-agents.ts`) criando/configurando o agente "Raquel" **inactive** (kill-switch), com tudo acima — deixando só o doc da agência + calendar_id + ativação como placeholders a preencher quando o time enviar. Depois: smoke com número de teste → cutover.
