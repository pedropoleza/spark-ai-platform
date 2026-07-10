# Import de planilha → disparo: post-mortem Jussara 03/07 + plano (H49)

> Estudo + plano · 2026-07-10 · pedido do Pedro ("houve problema com importação da planilha e envio de mensagens, isso não pode ocorrer").
> Caso: Jussara Ferreira (+16892033343, rep `8dc0cb84…`, location `pGl5pqLLG0QDixANpFnP`), 03/07 15:41→17:19 UTC.
> Markers: 🤖 Claude · 👤 Pedro · 🤝 híbrido.

---

## 1. O que aconteceu (linha do tempo, dados reais)

- **15:41** Jussara manda `Listas pra o Robo mandar FLuxo.xlsx` (23 linhas) + instrução: disparar mensagem de triagem, primeiro nome, artigo correto (personalização por gênero).
- **15:42:20 — 39 SEGUNDOS depois do upload** — bot: *"A planilha expirou (TTL 30 min). Manda o arquivo de novo"*. **Não existe TTL nenhum no sistema** (ver §2). A partir daí, o loop:
- **Ela reenviou a MESMA planilha 12 vezes em 1h21** (15:42, 15:43, 15:46, 15:47, 16:48, 16:56, 16:58×2, 16:59, 17:01×2, 17:01:57). A cada resposta dela SEM o anexo (confirmar botão, "1", "Tudo ok", "Sim"), o bot chamava a tool de novo, não achava o arquivo e pedia reenvio — com direito a explicação inventada: *"cada vez que você manda uma nova mensagem sem o arquivo, o timer reinicia"* (fabricação).
- **15:48** — *"Tô levando tempo demais... precisei parar pra não travar"* (mesma classe do timeout do Luciano; o fix de deadline 9e7bb25 é do próprio dia 03/07).
- No meio do loop, a contagem flutuou sem explicação coerente pro rep: 22 → "17 prontos (19 importados, 2 já existiam)" → preview por tag retornando **0 ou 2 contatos** ("ainda não indexou") → o bot decidiu *"vou disparar assim mesmo"*.
- **17:02** — finalmente, num turno em que TUDO rodou junto (analyze+import+preview+schedule), o job saiu: **"Triagem Fluxo CRM - 03/07"**, 17 contatos.
- **17:19** — Jussara: **"Você mandou a mensagem diferente"**. O texto enviado ("Oi {first_name}, tudo bem? 😊 Aqui é a Jussara! Queria bater um papo rápido…") NÃO era o que ela aprovou — nas 12 iterações o template foi sendo reescrito pelo LLM ("texto neutro") e a versão final divergiu da aprovada. **12 pessoas receberam a mensagem errada.**
- **17:19:47** — "Parar disparo" → job pausado. **Os 5 contatos restantes (Ayeska, Barbara, Marta, Edson, Izabella) estão `pending` ATÉ HOJE (7 dias)** — ninguém foi avisado, nem ela nem admin. O snapshot deles carrega o MESMO texto errado (retomar sem corrigir = mais 5 mensagens erradas).
- Ela nunca mais tocou no fluxo de planilha (desistiu da feature).

## 2. Causas-raiz (6, todas confirmadas no código/dados)

**RC1 — Arquitetura: o arquivo é EFÊMERO por turno.** `analyze_tabular_data`/`import_contacts_from_data` só enxergam `ctx.attachment` do turno ATUAL ([tabular.ts:59-63](../../src/lib/account-assistant/tools/tabular.ts)). Um fluxo que por design é MULTI-turno (analisar → confirmar mapping → importar → preview → disclaimers → confirmar disparo) exige o arquivo em cada turno que toca as tools → **impossível de completar sem reanexar N vezes**. É o mesmo problema que o H41 já resolveu pra follow-up ("a tarefa é um OBJETO PERSISTENTE, não uma lembrança") — nunca foi aplicado ao caminho planilha→bulk.

**RC2 — Alucinação de explicação técnica.** O erro real da tool é "Não tem planilha anexada nesta turn". O bot inventou "TTL 30 min"/"o servidor só guarda 30 minutos"/"o timer reinicia" e repetiu como fato 8×. Classe anti-alucinação: a tool não dá ao LLM uma explicação honesta pronta, então ele fabrica uma.

**RC3 — Sem estado persistente do fluxo → template drift.** Cada iteração re-decidia mapping/filtro/texto do zero (memória do LLM). O texto aprovado (personalizado por gênero, da planilha) virou "texto neutro" reescrito → **mensagem errada pra 12 pessoas**. Não há draft com template CONGELADO que o rep aprovou (o `commit_draft` do orquestrador H41 tem exatamente essa semântica — não cobre bulk).

**RC4 — Preview por TAG recém-criada = race de indexação.** O import DEVOLVE os ghl_ids de todos os criados ([tabular.ts:318-347](../../src/lib/account-assistant/tools/tabular.ts)) mas **só 5 vão pro LLM** (`created_sample`) e a lista completa é descartada → o disparo teve que filtrar pela tag `triagem-fluxo-crm` criada segundos antes → GHL não indexou → 0/2 contatos → bot improvisa. O alvo deveria ser **os IDs que o próprio import devolveu**.

**RC5 — Import rodou ≥4× sem guard.** Mitigado por sorte: o import usa `POST /contacts/upsert` (idempotente por phone/email — **não duplicou contatos** ✅). Mas as contagens divergentes (22/17/19/2) confundiram o rep, e não há guard "essa planilha já foi importada há X min" nem idempotência de JOB.

**RC6 — Stall silencioso.** Job `paused` com 5 `pending` por 7 dias, zero notificação (o notifier de stalled cobre outros casos, não "pausado por humano e esquecido"). O caso Ricardo Matte do estudo H47 é o mesmo padrão em micro (fluxo morre em silêncio quando abandonado).

## 3. Plano (H49) — planilha→disparo como objeto persistente

### F1 — Persistir arquivo + rows (mata RC1) 🤖
Upload de planilha → salvar o binário no bucket **`agent-media`** (já existe, H41/migration 00116) + parsear e gravar **snapshot dos rows** em `task_drafts` (kind `import_bulk`, migration aditiva) com meta {filename, columns, mapping, row_count}. As tools tabulares ganham fallback: sem `ctx.attachment`, carregam o ÚLTIMO draft `import_bulk` aberto do rep (janela 24h) — **o rep nunca mais reanexa**. TTL real de limpeza: 7 dias (purge no cron de cleanup).

### F2 — Fluxo vira draft com template congelado (mata RC3) 🤖
Reusar o padrão do orquestrador: o fluxo planilha→disparo vive num draft persistente (`show_draft`-like: mapping, filtro, **texto EXATO aprovado**, opções de personalização, decisões já tomadas — Ayeska in/out etc.). O schedule só dispara **o texto do draft** (nunca reescrito pelo LLM); qualquer mudança de texto exige novo aceite. Coerência: "o que ela aprovou = o que sai" vira garantia estrutural, não esperança.

### F3 — Disparo por IDs do import (mata RC4) 🤖
`import_contacts_from_data` grava a lista COMPLETA de ghl_ids no draft (não só 5 samples). `preview/schedule_bulk_message_v2` ganham modo `target: contact_ids[]` (os recipients já são por contact_id no DB — o runner não muda). Preview por tag vira fallback, com aviso explícito de indexação quando usado a <10min de um import.

### F4 — Erro honesto + prompt (mata RC2) 🤖
Mensagem de erro da tool reescrita pra dar ao LLM a explicação VERDADEIRA e a saída ("o arquivo chega junto da mensagem; com o draft persistente eu sigo de onde parei — não preciso do arquivo de novo"). Prompt: proibição explícita de inventar mecânica interna (TTL/servidor/timer) — se a tool não explicou, diga "tive um problema ao ler o arquivo" e siga o fluxo de recuperação.

### F5 — Notifier de job esquecido (mata RC6) 🤖
Cron existente ganha check: job `paused` com `pending>0` há >24h → notifica o REP ("seu disparo X tá pausado com N pendentes — retomo, cancelo ou troco o texto?") + admin_signal. Cobre também `running` estagnado.

### F6 — Recovery do caso Jussara 🤝 (decisão 👤)
Job `8d622ac4…` pausado: os 5 pendentes carregam o texto ERRADO. Recomendação: **cancelar** o job e, se a Jussara quiser, disparar os 5 (ou os 17) com o texto CERTO — só com o teu go + confirmação dela (é outbound pra leads). O SparkBot pode chamá-la proativamente com contexto (mesmo padrão do caso Luciano).

### Validação 🤝
Teste E2E com planilha real (23 linhas, mesma estrutura): fluxo completo com 3 interrupções de turno no meio → zero reanexo, texto final == aprovado byte a byte, disparo pros ids. Replay do incidente como caso de teste. tsc/build + testes das tools.

## 4. Conexões com as outras frentes
- **H47 (Contact Engine)**: o loop consumiu confirmações interativas ("1", "Confirmar") que são a MESMA superfície do tap determinístico (F2 do H47); o draft persistente daqui é primo do "contrato de estado das opções" de lá.
- **H48 (Blocked Slots)**: mesma semana, mesma rep, fricção de agenda ("Tem horário na agenda agora?" → 3 rodadas de "não tem slot" sem motivo).
- **Luciano (fix 9e7bb25)**: o deadline no resolveSegments já cobre o timeout do preview; este plano remove a outra metade (o fluxo não recomeça mais do zero).
