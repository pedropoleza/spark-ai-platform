# Handoff — Comandos via webhook do Spark Leads → SparkBot (H71)

**Sessão de origem:** 2026-08-05
**Branch:** `feat/webhook-commands` (a partir de `e1eb473` = main)
**Estado:** 4 módulos de lib escritos e compilando. Rota, migration, testes e docs NÃO existem ainda.
**Pedro está esperando:** a URL do webhook e um payload de exemplo pra mandar um teste. **Isso ainda não foi entregue a ele.**

---

## 1. O que o Pedro pediu

Uma forma de as automações de dentro das contas do Spark Leads mandarem comando pro SparkBot. Dois tipos, escolhidos por um campo no custom data:

- **`notification`** — o SparkBot manda o texto **como está** pro WhatsApp do corretor. Serve pra avisar coisa da conta a partir de automação.
- **`prompt`** — o SparkBot **responde o prompt** e manda a resposta dele pro WhatsApp, sabendo que veio de um comando externo. É proatividade sob comando.

Requisitos que ele nomeou explicitamente:

1. O webhook sempre sai de dentro de uma conta do Spark Leads, e o payload carrega o `location_id` — **essa é a camada de autenticação pretendida**.
2. Um campo de tipo (ele chamou de "message type" / "notification type") e um campo de mensagem.
3. Um campo com **o número que deve receber**.
4. **Trava de escopo:** só pode mandar pra números *daquela* location. Tem que verificar se o telefone pertence à conta que disparou o webhook.

---

## 2. Onde parei — exatamente

Tudo em `src/lib/account-assistant/webhook-commands/`. `npx tsc --noEmit` passa limpo no worktree.

| Arquivo | O que faz | Estado |
|---|---|---|
| `parse.ts` | Lê o payload do Spark Leads e devolve `ParsedCommand` ou erro explicado | ✅ completo |
| `authorize.ts` | As 3 travas (segredo → location conhecida → telefone dentro da location) + bloqueio de termos recusados | ✅ completo |
| `run.ts` | Executa `notification` e `prompt`, entrega e cobra | ✅ completo |
| `audit.ts` | Trilha em `sparkbot_webhook_commands` + idempotência | ⚠️ precisa de um ajuste (item 4.2) |

**Nada foi commitado antes deste handoff.** O commit que acompanha este arquivo põe os 4 módulos na branch e empurra pro GitHub — não deixa nada só no disco.

---

## 3. Decisões já tomadas (não refazer sem motivo)

**3.1 — `location_id` sozinho não é segredo, e o código assume isso.**
Ele aparece em URL de painel, link de formulário e print de tela. Por isso `authorize.ts` trata o location id como *"de qual conta veio"*, nunca como *"quem mandou é autorizado"*. A trava real é a combinação com a regra do telefone: mesmo quem descobrir um location id só consegue mandar mensagem pra corretor **daquela mesma conta** — que é justamente quem já receberia aviso dela. Existe suporte a `SPARKBOT_COMMAND_SECRET` (header `x-spark-secret` ou campo `secret`), com comparação de tempo constante, e enquanto a env não existir a checagem passa. **Recomendação pro Pedro: setar o segredo depois que o teste passar.**

**3.2 — O campo `phone` do payload NUNCA é o destino.**
O payload de automação do Spark Leads já traz `phone` = telefone **do lead**. Se aceitássemos, o aviso do corretor iria pro cliente. `CAMPOS_DESTINO` em `parse.ts` exclui `phone`/`contact_phone` de propósito e o erro de destino ausente explica isso. **Essa é a armadilha mais fácil de reintroduzir por "simpatia" com o payload — não mexer.**

**3.3 — Merge field não resolvido conta como ausente.**
O Spark Leads entrega `{{contact.phone}}` literal quando não consegue resolver. `isMergeFieldNaoResolvido()` rejeita, e o erro diz que o merge field não resolveu. Mesma classe do falso-positivo do F52.

**3.4 — Modo `prompt` só recebe tools de risco `safe`.**
Um comando roda **sem humano no circuito**: não existe "Confirma?" pra responder no meio de um turno disparado por automação. Liberar tool de escrita significaria automação mal configurada disparando campanha ou remarcando agenda sem ninguém ver. `safeToolNames()` deriva a lista do `TOOL_REGISTRY` por `def.risk === "safe"` — tool nova nasce liberada se for de leitura, e nunca liberada se for de escrita. Se o Pedro pedir ação de escrita depois, o caminho é um campo explícito (`allow_actions`), não afrouxar o default.

**3.5 — Os dois modos terminam em `deliverProactiveMessage`.**
Não é economia de código: é o que faz o comando herdar o gate de opt-in do WhatsApp (anti-ban Meta), a resolução de hub e a persistência em `sparkbot_messages` — o corretor vê no painel mesmo se o WhatsApp falhar.

**3.6 — Quiet hours e silence gate NÃO se aplicam; cap diário se aplica.**
Quem escolheu a hora foi a automação da própria conta. E o silence gate existe pra frear proativo que o *bot* decidiu mandar — engolir um aviso que a conta pediu explicitamente seria repetir o erro do "inbound MUDO" (4.013 sinais presos sem ninguém ver). No lugar, a trava é quantitativa: `SPARKBOT_COMMAND_DAILY_CAP` (default 50/corretor/24h), que protege de workflow em loop sem silenciar aviso legítimo.

**3.7 — O modo `prompt` injeta "CONTATO EM CONTEXTO" e propaga `contact_id` no metadata.**
Sinergia com o H45/F8: o próximo inbound do corretor herda o contato em foco. Ele responde "liga pra ela" e o bot sabe de quem se trata.

---

## 4. O que falta — em ordem

### 4.1 Migration `sparkbot_webhook_commands` 🤖

O schema está implícito nos inserts de `audit.ts`. Colunas:

```
id uuid pk default gen_random_uuid()
received_at timestamptz not null default now()
location_id text
rep_id uuid references rep_identities(id) on delete set null
send_to text
kind text
message text
contact_id text
request_id text
fingerprint text
status text not null       -- 'running' | 'sent' | 'rejected' | 'failed' | 'duplicate'
reason text
detail text
delivered_via text          -- 'whatsapp' | 'system' | null
response_text text
duration_ms integer
metadata jsonb not null default '{}'::jsonb
```

Índices: `(location_id, received_at desc)`, `(rep_id, received_at desc)`, `(fingerprint, received_at desc)`.

**Índice único parcial recomendado** — idempotência dura quando a automação manda `request_id`:
```sql
create unique index ... on sparkbot_webhook_commands (location_id, request_id)
  where request_id is not null;
```

⚠️ **Numeração:** o repo tem `00130_suppress_ad_context.sql` como último numerado, e os 3 mais novos usam timestamp do ledger (`20260716204119_activation_mode.sql`). Colisão de número curto entre branches já causou estrago (ver `_planning/auditoria-trabalho-perdido-2026-08-05.md`). **Usar nome em timestamp.** Criar o arquivo mesmo aplicando via MCP.

### 4.2 Ajuste no `audit.ts` — claim antes de executar ⚠️ 🤖

Tem uma corrida real no modo `prompt`: ele leva ~20s, e a auditoria só é gravada **depois**. Dois webhooks idênticos em 60s não se enxergam, porque `acharDuplicata` procura status `('sent','duplicate')` e ainda não existe linha nenhuma. **Os dois executam e o corretor recebe duas mensagens.**

Correção:
1. Adicionar `"running"` ao tipo `CommandStatus`.
2. Gravar a linha com `status='running'` **antes** de executar (claim), guardando o `id`.
3. Incluir `'running'` na lista de status que `acharDuplicata` considera duplicata.
4. Criar `finalizarComando(id, patch)` que dá `UPDATE` na linha com o resultado (status final, `delivered_via`, `response_text`, `duration_ms`, `detail`).
5. Linha `running` órfã (lambda morreu no meio) fica visível na auditoria — é sinal, não bug.

### 4.3 Rota `src/app/api/webhooks/sparkbot-command/route.ts` 🤖

`export const maxDuration = 60`. Fluxo:

```
1. flag SPARKBOT_WEBHOOK_COMMANDS_ENABLED off → 503
2. body = await req.json()  (fail → 400 payload_invalido)
3. rate limit por location (30/min, Map em memória, mesmo padrão de
   inbound-message/route.ts) → 429 SEM gravar auditoria
   [é isso que impede workflow em loop de inflar a tabela]
4. parseWebhookCommand → erro: 400 + auditoria(rejected)
5. authorizeCommand → erro: usa result.httpStatus + auditoria(rejected)
6. fingerprint + acharDuplicata → 200 {duplicate:true} + auditoria(duplicate)
7. cap diário (contarEnviosRecentes >= dailyCap) → 429 + auditoria(rejected)
8. claim: registrarComando(status='running') → guarda id
9. notification → executa SÍNCRONO, finalizarComando, responde o resultado
   prompt      → responde 202 {accepted:true} e executa em waitUntil(),
                 finalizarComando no fim
10. header x-spark-secret entra como segredoHeader no authorize
```

**Por que `notification` é síncrono e `prompt` não:** o aviso é um envio só (~2s) e o Pedro precisa ver o resultado na resposta pra testar. O prompt roda LLM com tools e estoura o timeout do webhook — a prova pra ele é a mensagem chegando no WhatsApp + a linha na auditoria.

**Códigos HTTP de propósito** (não 200-pra-tudo): erro fica visível no log de workflow do Spark Leads. 400 payload, 401 segredo, 403 location/telefone/termos, 404 corretor, 429 rate/cap, 503 flag off ou falha de consulta.

### 4.4 Flag + envs na Vercel 👤/🤖

- `SPARKBOT_WEBHOOK_COMMANDS_ENABLED=1` — **criar em produção antes de avisar o Pedro**, senão o teste dele bate em 503. (Convenção do projeto é default OFF; a flag existe como kill switch.)
- `SPARKBOT_COMMAND_SECRET` — opcional, recomendada **depois** do primeiro teste passar.
- `SPARKBOT_COMMAND_DAILY_CAP` — opcional, default 50.
- `SPARKBOT_COMMAND_DEDUP_SECONDS` — opcional, default 60.

### 4.5 Teste `scripts/test-webhook-command.ts` 🤖

Puro, sem banco, sobre `parseWebhookCommand` / `repAtendeLocation` / `verificarSegredo` / `fingerprintComando`. Casos que **têm** que estar:

- `phone` do lead presente e `send_to` ausente → **erro de destino** (nunca cair no `phone`). *Este é o teste que protege a decisão 3.2.*
- `send_to: "{{contact.phone}}"` → erro de destino, com a menção ao merge field.
- location em `location.id` aninhado, em `location_id` na raiz, e dentro de `customData`.
- sinônimos de tipo: `aviso`, `notificação` (com acento), `NOTIFICATION`, `prompt`, `comando`.
- tipo desconhecido → erro (não adivinhar).
- modo prompt com `prompt` e `message` preenchidos → o `prompt` vence.
- `repAtendeLocation`: match por `active_location_id`, match por `ghl_users[].location_id`, e **não-match** (a regra que o Pedro pediu).
- `verificarSegredo`: sem env → passa; com env e segredo errado → falha; header e body funcionam.

### 4.6 Docs 🤖

- `docs/DECISIONS.md` → **H71** (H70 é o último; conferido).
- `CLAUDE.md` → seção nova descrevendo o endpoint, os 2 modos, as 3 travas e a regra do `phone`.
- Memória: vale um arquivo `webhook-commands-spark-leads.md` no diretório de memória + linha no `MEMORY.md`.

### 4.7 Deploy e entrega ao Pedro 🤖/👤

1. PR pra main (a sessão inteira foi por PR — não empurrar direto).
2. `npx vercel ls --prod` até o deploy novo aparecer **Ready**. "Pushed" ≠ "deployado" (incidente 2026-07-10→14).
3. **Aí sim** mandar pro Pedro a URL + o payload da seção 5.

---

## 5. O que prometi ao Pedro (entregar quando 4.1–4.4 estiverem no ar)

**URL** (domínio de produção confirmado por `vercel inspect`):

```
https://spark-ai-platform.vercel.app/api/webhooks/sparkbot-command
```

**Método:** POST · **Content-Type:** application/json

**Aviso simples:**
```json
{
  "location_id": "<id da sub-conta>",
  "message_type": "notification",
  "send_to": "+17867717077",
  "message": "O lead Fulano acabou de pedir retorno pelo formulário."
}
```

**Comando pro bot responder:**
```json
{
  "location_id": "<id da sub-conta>",
  "message_type": "prompt",
  "send_to": "+17867717077",
  "prompt": "Resume o que rolou com esse lead e diz qual o melhor próximo passo.",
  "contact_id": "<id do contato, opcional>"
}
```

Na ação de webhook do Spark Leads, `location.id` e `contact_id` normalmente já vão sozinhos; o que ele precisa adicionar no custom data é **`message_type`**, **`send_to`** e **`message`** (ou `prompt`).

**O que avisar junto:**
- `send_to` é o **corretor**, não o lead. O `phone` do payload é ignorado de propósito.
- O número precisa ser de alguém que já conversou com o SparkBot pelo menos uma vez (senão cai no painel web em vez do WhatsApp — comportamento do gate de opt-in, não bug).
- No modo `prompt` o bot só consulta; não executa ação de escrita sozinho.

---

## 6. Armadilhas achadas nesta sessão

**6.1 — O working tree do Pedro (`fix/3-frentes-onda0-1`) está ATRÁS do main.**
Li `whatsapp-delivery.ts` no diretório principal e peguei a versão **velha** (só Stevo). No main o arquivo já roteia por `pickWaTransport` → SparkZap (H57). O contrato de `deliverProactiveMessage` é o mesmo e o `tsc` passa, mas **ler arquivo no diretório principal dá versão desatualizada**. Trabalhar no worktree `wt-zap`.

**6.2 — O envio real depende de duas envs que já existem em prod.**
`WHATSAPP_DELIVERY_ENABLED=1` e `isSparkbotSendEnabled()` (lê `SPARKBOT_SEND_ENABLED`, com fallback pro nome antigo `STEVO_SEND_ENABLED`). Se o teste "funcionar" mas nada chegar no WhatsApp, olhar essas duas antes de suspeitar do código novo.

**6.3 — `pickWaTransport` tem allowlist por telefone (`SPARKZAP_REPS`).**
Rep fora da lista cai no transporte antigo. Se o teste for com um número específico, conferir onde ele cai.

**6.4 — `supabase-js` não é tipado contra o schema aqui.**
`.from("sparkbot_webhook_commands")` **compila mesmo sem a tabela existir** — foi por isso que o `tsc` passou antes da migration. Não confundir tsc verde com tabela criada.

---

## 7. Como validar de ponta a ponta

1. `npx tsc --noEmit` e `npm run build` no worktree.
2. `npx tsx scripts/test-webhook-command.ts` — todos verdes.
3. Aplicar a migration e conferir contra `information_schema.columns`.
4. `curl` local/prod com payload de `notification` pro número do próprio Pedro (**7867717077**) → mensagem no WhatsApp + linha `status='sent'` na auditoria.
5. Caso negativo, o mais importante: `send_to` de um corretor de **outra** location → tem que voltar **403 `telefone_fora_da_location`**. É a regra que o Pedro pediu; sem esse teste a feature não está validada.
6. Payload com `phone` do lead e sem `send_to` → 400 destino ausente.
7. Modo `prompt` com um contato real → conferir a mensagem gerada e o `contact_id` no metadata de `sparkbot_messages`.

---

## 8. Contexto de fundo que importa

Esta sessão inteira foi sobre trabalho que se perdeu por ficar fora do main. O Pedro pediu explicitamente que tudo passe por GitHub. **Não deployar direto pela Vercel e não deixar código só no disco** — commit na branch, PR, merge, e conferir o deploy Ready.

Pendências anteriores que continuam abertas e não têm relação com esta feature (mas aparecem se alguém varrer o repo): canal de alerta `ALERT_*` não configurado, `MARINA_DAILY_PHONE` faltando, `TurnContext` como código morto, e a opção de UI "Criar no funil" nunca verificada visualmente. Detalhe em `_planning/auditoria-trabalho-perdido-2026-08-05.md`.
