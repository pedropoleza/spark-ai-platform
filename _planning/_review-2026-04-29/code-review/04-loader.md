# Code Review — `loader.js` (Custom JS injetado no GHL)

Escopo: `src/app/embed/sparkbot/loader/route.ts`, `src/app/embed/sparkbot/page.tsx`,
`src/app/embed/sparkbot/layout.tsx`, e referência `src/lib/account-assistant/web-auth.ts`.

---

## Resumo executivo

O loader é defensivo no essencial: guard de injeção dupla (`__sparkbotInjected`),
fallback flutuante quando não acha header, watcher pra re-inserir botão se Vue
re-render destroi o DOM, debounce no boot esperando contexto da SPA, e helper
de debug pra Pedro. Esse é o "meio do bolo" — funciona pro caso feliz.

Riscos reais (todos não-bloqueadores pra MVP, mas vão queimar em produção
real com 4-8h de uso):

1. **Token JWT expira em 1h sem refresh** (`web-auth.ts:21`, `route.ts:171`).
   Após 60min, todo `/send`, `/inbox`, `/transcribe` retorna 401 silenciosamente
   — o painel vira "burro" até reload. Rep não vê nenhum aviso.
2. **Memory leaks em sessão longa** (`route.ts:70`, `route.ts:505-513`):
   `STATE.lastSeenIds` é `Set` sem tampa, e há 3 `setInterval` sem `clearInterval`
   se o loader for re-injetado (raro mas possível).
3. **Erros silenciados em massa** (`route.ts:194,458,470,478`): qualquer falha
   de rede ou backend é `console.warn` no máximo. Rep não tem feedback algum.
4. **Multi-tab causa badge stale** (não bug, mas UX): tab B não reflete leitura
   feita em tab A até o próximo poll de 15s. Aceitável, dado o intervalo.
5. **Injeções DOM 60+/h**: o watcher de header roda a cada 3s. É idempotente
   (`route.ts:308`), mas o `setInterval` nunca para — em sessão de 8h roda 9.600x.
   Custo desprezível, só bom saber.

UX: dois pontos importantes — botão 36×36 abaixo do alvo touch recomendado
(44×44 WCAG) e i18n totalmente PT-BR hardcoded (não escala pra white-labels
não-brasileiros).

Técnico: há um bug **real e reproduzível** no `cancelRecording`
(`page.tsx:185`) — chama `mediaRec.current.stream.getTracks()`, mas o tipo
`MediaRecorder.stream` é uma propriedade somente-leitura que não foi
explicitamente passada — funciona, mas o jeito mais idiomático é guardar
`stream` em ref. Mais grave: `mediaRec.current.onstop = null` não cancela
o callback se ele já tiver sido enfileirado.

---

## Bugs / Inconsistências

| # | Tipo | Severidade | File:line | Descrição | Fix |
|---|------|-----------|-----------|-----------|-----|
| 1 | Token expira sem refresh | **HIGH** | `loader/route.ts:171,443,476`; `web-auth.ts:21` | JWT TTL = 1h. Após expirar, todas as chamadas voltam 401 e o loader não tem caminho de re-auth. `poll()` e `heartbeat()` engolem o erro silenciosamente. Painel quebra até reload. | Detectar 401 em `poll`/`heartbeat`/`send` → chamar `authenticate()` de novo. Se falhar 2x, mostrar toast "Sessão expirou — clica pra reconectar". |
| 2 | Memory leak em `lastSeenIds` | **MED** | `loader/route.ts:70,455` | `STATE.lastSeenIds = new Set()` cresce sem limite. Cada poll add IDs. Em 8h × 240 polls × ~5 msgs = 1200 IDs. Não é catastrófico, mas em rep que mantém tab aberta dias, vira leak gradual. | Truncar pra últimos 200 IDs: `if (STATE.lastSeenIds.size > 200) { STATE.lastSeenIds = new Set([...STATE.lastSeenIds].slice(-100)); }`. |
| 3 | `setInterval` sem `clearInterval` | **MED** | `loader/route.ts:505-513,551` | Se loader for re-injetado por algum motivo (flag `__sparkbotInjected` perdida em SPA mount/unmount), os 4 intervalos antigos continuam rodando. Cada navegação acumularia poll duplo, triplo, etc. | Guardar refs dos intervalos em `STATE._intervals = []` e antes de `setInterval` chamar `STATE._intervals.forEach(clearInterval)` no boot. |
| 4 | `cancelRecording` race no callback | **MED** | `page.tsx:182-186` | `mediaRec.current.onstop = null` antes de `.stop()` evita callback **se ainda não tiver sido invocado**. Mas `stop()` é assíncrono — em alguns navegadores o `dataavailable + stop` já podem ter sido enfileirados. Resultado: upload de áudio cancelado pode rodar mesmo assim. | Usar flag explícita: `let cancelled = false; rec.onstop = async () => { if (cancelled) return; ... }`. Setar `cancelled=true` em `cancelRecording`. |
| 5 | `panel.classList.toggle("open")` perde estado de polling | **LOW** | `loader/route.ts:381-389` | `togglePanel` chama `markAllRead`/`updateBadge(0)` apenas quando abre. Se usuário fecha e reabre rapidamente, ok. Mas se rep abre tab B (loader B faz poll, vê msg, marca badge=1), depois rep abre painel em tab A e fecha rapidamente, tab B continua com badge fantasma até próximo poll. | Aceitável (15s window). Documentar como "OK by design" — refresh é em background. |
| 6 | `iframe.src` regenera em cada toggle? Não | OK (false positive) | `loader/route.ts:373-382` | togglePanel só cria iframe uma vez. Subsequentes só toggle CSS. Iframe preserva state — bom. | n/a |
| 7 | `Notification.requestPermission()` em iframe parent | **LOW** | `loader/route.ts:411-421` | A chamada é feita pelo loader que roda no **parent** (GHL window), não dentro do iframe. Isso é correto. Mas requestPermission só é chamado no primeiro `togglePanel` — se rep nunca abriu painel, msgs proativas não notificam. | Considerar chamar permission request logo após `injectFab()` (com delay leve). Trade-off: prompt aparece sem rep ter acionado nada — pode irritar. Mantém atual mas documenta. |
| 8 | `markAllRead` envia `message_ids: []` | **LOW** (intencional?) | `loader/route.ts:469`, `page.tsx:84` | `[]` significa "marca tudo lido" no backend? Confirmar contrato com `/api/sparkbot/inbox` POST. Se backend espera lista explícita, chamada é no-op silenciosa. | Verificar `src/app/api/sparkbot/inbox/route.ts` POST handler. Se for "marca tudo", documentar; se não, fix. |
| 9 | Inconsistência "Sparkbot" vs "SparkBot" | **LOW** | múltiplos: `loader/route.ts:312,313,427`; `page.tsx:243`; `layout.tsx:7` | `title="SparkBot"`, `aria-label="Abrir SparkBot"`, mas `new Notification("Sparkbot", ...)`, `title: "Sparkbot"` no metadata. | Padronizar pra "SparkBot" (camelCase) em toda UI visível. |
| 10 | Botão 36×36 abaixo do alvo touch | **LOW (mobile)** | `loader/route.ts:212` | WCAG 2.5.5 recomenda ≥44×44 pra touch. 36×36 é ok inline com outros ícones do GHL no desktop, mas em tablet/mobile fica difícil de acertar. O fallback floating já é 56×56, ok. | Em viewport <768px, aumentar `.sparkbot-btn` pra 44×44. Já tem media query 600px pro panel. |
| 11 | `findHeaderContainer` warn não é visível | **LOW (UX)** | `loader/route.ts:345` | `console.warn` quando cai no fallback floating. Pedro não vê. Em white-label de cliente onde GHL mude o markup, ele não saberia. | Em produção, manter warn. Pra Pedro: `__sparkbotDebug()` já mostra `header_found`. OK. |
| 12 | `i18n` zero | **LOW (escala)** | `loader/route.ts:312-313,425-427`; `page.tsx:29-34,229,287,599-602` | "SparkBot — copiloto IA", "copiloto IA · Spark Leads", "Manda uma pergunta ou pedido", suggestions, etc — tudo PT-BR hardcoded. | Para outros white-labels, extrair pra dicionário e detectar via `navigator.language` ou param do JWT. Não-bloqueador hoje (Pedro só atende BR). |
| 13 | `aria-label` ausente no painel SPA | **LOW (a11y)** | `page.tsx:282-316,260` | `<textarea>` não tem `aria-label`. `<Bubble>` não tem `role="article"` ou similar. Screen reader anuncia "edit" sem contexto. Mensagens não têm `aria-live` pra anunciar nova resposta. | Adicionar `aria-label="Mensagem para o SparkBot"` no textarea, `role="log" aria-live="polite"` no `.scroll`, `role="article"` em cada bubble. |
| 14 | `iframe.allow="notifications"` é inválido | **LOW** | `loader/route.ts:366` | A diretiva válida é `notifications` apenas em alguns drafts; spec atual de Permissions Policy usa `display-capture`, `microphone`, `camera`, `geolocation`, etc. `notifications` em `iframe.allow` é silenciosamente ignorado pelo Chrome. Notificações em iframe cross-origin já são restritas — funciona apenas porque o `Notification.requestPermission()` é chamado no parent (loader). | Remover `notifications` do `allow` (não-funcional). Manter `microphone; clipboard-write`. |
| 15 | Detect heurístico do GHL Vue context é frágil | **LOW** | `loader/route.ts:88` | Loader tenta `localStorage["refreshedToken"]`, `"token-id"`, `"ghl_user_token"`. Em white-labels (sparkleads), a chave atual é `refreshedToken`. Se GHL mudar nome da chave, loader silenciosamente cai pros fallbacks `__INITIAL_STATE__` que provavelmente também já não existem mais. | Adicionar telemetria leve: se nenhuma chave bater, POST `/api/sparkbot/check-admin` com `idToken: null` e backend loga tentativa de auth sem context. Permite Pedro descobrir antes do rep reportar. |

---

## Otimizações P1 (não-bloqueador)

### Token refresh (#1, mais urgente em produção)

Adicionar retry automático em todas as chamadas autenticadas:

```js
// helper único pra todas as chamadas autenticadas
function authedFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers.Authorization = "Bearer " + STATE.token;
  return fetch(url, opts).then(function(r) {
    if (r.status === 401) {
      // Token expirou — tenta re-auth
      return authenticate().then(function(ok) {
        if (!ok) {
          showToast("SparkBot precisa reautenticar — recarregue a página");
          throw new Error("auth-failed");
        }
        opts.headers.Authorization = "Bearer " + STATE.token;
        return fetch(url, opts);
      });
    }
    return r;
  });
}
```

Refatorar `poll`, `heartbeat`, `markAllRead` pra usar `authedFetch`. No
`page.tsx` (iframe), o token tá embedded na URL — então iframe precisa
escutar `postMessage` do parent pra receber novo token. Alternativa
mais simples: iframe verifica 401 e força reload do iframe inteiro
(loader re-injeta novo iframe com novo token).

### Error feedback (#3)

Toast simples no parent quando ações falham:

```js
function showToast(msg, kind) {
  // criar div fixo top-right, fade out 4s
  ...
}
```

Casos a logar:
- `check-admin` falhou (não-rede): "SparkBot indisponível"
- `poll` 401: "Sessão expirou"
- `send` falhou: já é exibido no `page.tsx:265` via `error` state — ok no iframe.
  No parent (badge), seria útil mostrar discretamente.

### Memory cleanup (#2, #3)

Truncar `lastSeenIds` (fix #2) e guardar interval refs (fix #3).
Na `boot()`, antes de iniciar intervals novos:

```js
if (window.__sparkbotIntervals) {
  window.__sparkbotIntervals.forEach(clearInterval);
}
window.__sparkbotIntervals = [];
window.__sparkbotIntervals.push(setInterval(poll, POLL_MS));
// ... idem pros outros
```

### Multi-tab BroadcastChannel (otimização, baixa prioridade)

Pra evitar 2 polls + 2 heartbeats redundantes:

```js
var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sparkbot') : null;
// Eleger leader: primeira tab que abrir vira leader, faz polling, broadcast
// pra outras. Se fechar, próxima tab assume.
```

Complexidade alta pra ganho marginal — Pedro tem ~10 reps, polling 2x não
vai matar nada. **Skipar.**

---

## Hardening

### CSP (Content Security Policy)

GHL **não** parece bloquear scripts externos hoje (custom JS é uma feature
suportada pelo HighLevel via Agency Settings → Custom CSS/JS). Não foi
confirmado em produção mas o caminho `<script src="...">` injetado por
Custom JS é o método oficial. **OK assumir suportado.**

Risco: se GHL adicionar CSP mais estrita no futuro com `script-src 'self'`,
o loader externo é bloqueado. Mitigação: documentar como instalar pro
Pedro, ter plano B (publicar como GHL Marketplace App).

### Sandbox no iframe

Atualmente `iframe.allow = "microphone; clipboard-write; notifications"` mas
**não tem `sandbox`**. Iframe é same-origin (mesmo Vercel app), então
sandbox protegeria o GHL parent caso houvesse XSS no painel SPA. Hoje, sem
sandbox, um XSS no iframe pode ler `parent.localStorage` (incluindo o
`refreshedToken` do GHL) — escalada de privilégio.

**Recomendação:** adicionar `sandbox="allow-scripts allow-same-origin allow-forms"`.
`allow-same-origin` é necessário pra MediaRecorder e fetch de mesmo domínio.
`allow-popups` se houver `window.open` (não tem hoje). **Não adicionar
`allow-top-navigation`** — iframe não deve poder navegar parent.

### Permissions Policy do GHL

`getUserMedia` em iframe cross-origin requer header `Permissions-Policy:
microphone=(self "https://spark-ai-platform.vercel.app")` no parent (GHL).
GHL **não controla isso pelo loader.js** — é configuração HTTP do response
do GHL.

**Validar:** abrir DevTools → Network → response do GHL → procurar header
`Permissions-Policy` ou `Feature-Policy`. Se não permitir microfone em
iframe cross-origin, MediaRecorder vai falhar com `NotAllowedError`. Hoje
o `page.tsx:169` cai em "permissão de microfone negada" e mostra erro —
mas rep não saberá distinguir "negou no prompt" de "GHL bloqueia totalmente".

Se GHL bloqueia: registrar bug com HighLevel ou usar Web Speech API
(`SpeechRecognition`) que não precisa de permissions policy explícita.

### XSS no `repName` query param

`page.tsx:57` faz `setRepName(params.get("repName") || "")` e renderiza em
`page.tsx:599` como `Oi {repName.split(" ")[0]}`. React escapa
automaticamente, então **não** há XSS. OK.

Mas no loader (`route.ts:365`) o `STATE.repName` vai pro `iframe.src` via
`encodeURIComponent` — também OK.

### `localStorage` leak do GHL token

Loader lê `refreshedToken` (JWT GHL completo) e envia ao backend
(`route.ts:169`, `route.ts:180`). **Pra que?** Backend usa pra validar
admin via claims (`route.ts:165` comentário). Se o backend não persiste
esse token, OK — mas vale confirmar que `/api/sparkbot/check-admin/route.ts`
não loga o `idToken` em telemetria nem persiste em DB.

---

## OK status — o que está bem feito

- **Guard de injeção dupla** (`route.ts:55-56`): `__sparkbotInjected` previne duplo botão se Custom JS rodar 2x.
- **Idempotência do `injectFab`** (`route.ts:308`): se já tem `.sparkbot-btn`, não duplica. Watcher de 3s seguro.
- **Detect de SPA navigation** (`route.ts:550-561`): re-auth quando `pathname` muda (location switch no GHL).
- **Boot polling com timeout** (`route.ts:485-520`): 30 tentativas × 1s = 30s pra pegar contexto. Desiste com warn em vez de loop infinito.
- **Cache de claims** (`route.ts:81`): `__ghlClaims` evita decodar JWT 4x. Pequena otimização.
- **Fallback flutuante** (`route.ts:343-346`): se header não for achado, painel funciona em modo flutuante.
- **Resposta `/send` direta** (`page.tsx:124-130`): não depende de polling pro chat — UX melhor (latência menor).
- **Optimistic UI** (`page.tsx:103-109`): bubble com typing indicator antes do server responder.
- **Token short-lived** (`web-auth.ts:21`): 1h é razoável. Mitiga blast radius se Custom JS leakar (#1 mostra que precisa refresh, mas o TTL curto é defensivo).
- **iframe state preservation** (`route.ts:373-382`): toggle não destrói iframe — preserva chat history sem reload.
- **Helper `__sparkbotDebug()`** (`route.ts:525-547`): excelente pra Pedro debugar problemas em prod sem IDE.
- **Merge optimistic** (`page.tsx:75-80`): poll no iframe respeita mensagens locais não-persistidas (`tmp-` prefix). Sem flicker.
- **Mascote sutil e amigável** (`page.tsx:531-587`): pisca olho a cada 5s, antena pulsa, "respira". Sem ser irritante.

---

## Top 3 ações recomendadas (priorização)

1. **#1 Token refresh** — em 1h de uso o painel quebra silenciosamente. Adiciona toast de erro + retry de 401. (1 dia de trabalho)
2. **#3 Cleanup de intervals + #2 truncar lastSeenIds** — barato, evita degradação em sessões longas. (2h)
3. **Hardening: `iframe sandbox`** — protege contra XSS no painel SPA escalando pro GHL parent. (30min)

Os outros são polimento ou edge cases. **OK pra Sprint 0.**
