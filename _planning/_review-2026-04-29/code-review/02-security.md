# Security Review — Sparkbot Web Integration

**Data:** 2026-04-29
**Escopo:** Custom JS injetado no GHL → painel iframe → API endpoints `/api/sparkbot/*`
**Reviewer:** security engineer (Claude review)

---

## Resumo executivo

**Estado de segurança:** **NÃO ACEITÁVEL para produção / aceitável só pra closed beta com Pedro/2-3 reps de confiança.**

Existe **uma vulnerabilidade CRÍTICA de privilege escalation** (`check-admin` aceita JWT do Firebase sem verificação de assinatura) que permite a qualquer pessoa na internet emitir um Bearer token válido pra qualquer `userId`/`companyId` do sistema, ganhando acesso completo ao Sparkbot daquele rep — incluindo histórico de conversas, capacidade de criar tasks/notes em contatos do CRM, drenar billing, e ler/escrever em qualquer location.

Adicionalmente, existem **3 problemas HIGH** (CORS aberto + token na URL → roubo via Referer / phishing; ausência total de rate limit) e **5 problemas MEDIUM/LOW**. A função `isUserAdmin` do SSO legacy também aceita `role === "user"` como admin (linha 79 de sso.ts), o que é provavelmente um bug — mas não é exposto pelo Sparkbot porque o caminho JWT-claims ataca antes.

**1 vulnerability summary:** o caminho de fast-fail é o `idToken` ser decodificado em base64 e os campos `claims.user_id`/`claims.company_id`/`claims.role` serem confiados sem verificação de assinatura (`check-admin/route.ts:75-109`). Como **qualquer um pode forjar um JWT** com `claims.role: "admin"` e `user_id`/`company_id` arbitrários, o atacante obtém um Bearer JWT válido (assinado pelo nosso servidor) que dá acesso completo a `/api/sparkbot/*`.

**Recomendação:** mitigar vuln #1 ANTES de abrir o piloto pra mais de 5 reps. Os outros HIGH podem ser endereçados em sprint subsequente.

---

## Vulnerabilidades

### CRITICAL

#### CVE-SB-001 — Privilege escalation via idToken não-verificado

**File:** `src/app/api/sparkbot/check-admin/route.ts:75-109`
**Severity:** CRITICAL
**CVSS estimado:** 9.1 (network, low complexity, no auth, scope unchanged, high impact CIA)

**Descrição:**
O endpoint `POST /api/sparkbot/check-admin` aceita um campo `idToken` no body, decodifica o segundo segmento (payload) em base64, e **NÃO verifica a assinatura JWT contra a chave pública do Firebase/Google JWKS**. O código apenas confere consistência interna (`claims.user_id === userId` e `claims.company_id === companyId`) e checa `claims.role`/`claims.type` contra uma lista de roles admin.

```ts
// linha 75-109 (resumido):
const parts = idToken.split(".");
const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
const claims = payload.claims || {};
const matchesUser = claims.user_id === userId;
const matchesCompany = claims.company_id === companyId;
if (matchesUser && matchesCompany && notExpired) {
  if (adminRoles.includes(role) || adminTypes.includes(type)) {
    isAdmin = true;
  }
}
```

O comentário linha 67-70 reconhece o trade-off ("Pra MVP confiamos no payload sem verify de assinatura") mas a premissa é falsa — **qualquer adversário SEM autenticação alguma pode forjar o JWT** porque a checagem de "consistência" tá baseada nos próprios campos do request body. O atacante controla `userId`+`companyId` no body e escreve esses mesmos valores nas claims forjadas. Não tem âncora externa de identidade.

**Exploit scenario:**
1. Atacante descobre um `userId` GHL e o `companyId` correspondente. Isso vaza por:
   - Logs de algum white-label,
   - Print de tela compartilhada,
   - Engenharia social (rep mostra a URL `/v2/location/<id>/...` num pedido de suporte),
   - URLs do GHL próprio (companyId tá em URLs públicas em alguns contextos).
2. Atacante forja um JWT trivial:
   ```js
   const header = btoa(JSON.stringify({alg:"HS256",typ:"JWT"}));
   const payload = btoa(JSON.stringify({
     claims: {
       user_id: "<userId-vítima>",
       company_id: "<companyId>",
       role: "admin"
     },
     exp: Math.floor(Date.now()/1000) + 3600
   }));
   const fakeJwt = `${header}.${payload}.signature_invalida`;
   ```
3. POST `/api/sparkbot/check-admin` com `userId`, `locationId` (qualquer location daquele company), `companyId` e o `idToken` forjado. **CORS é `*`**, então o atacante pode mandar de qualquer origin.
4. Server retorna `{ ok: true, token: "<JWT-real-assinado>" }`. Esse JWT É legítimo (signSparkbotWebToken assinou com `JWT_SECRET`).
5. Atacante usa o Bearer token em `/api/sparkbot/send`, `/api/sparkbot/inbox`, `/api/sparkbot/transcribe`. Pode:
   - Ler histórico inteiro do rep (todas as conversas WhatsApp + Web).
   - Mandar mensagens em nome do rep — Sparkbot vai criar tasks/notes/opps em contatos reais do CRM (tools tipo `create_note`, `create_task`).
   - Drenar billing via msgs sucessivas (1k msgs/min é trivial).
   - Transcrever áudios → drenar Whisper $$$.
   - Marcar mensagens como lidas (esconder evidência).

**Bypass do "fallback GHL API":** linha 112-119 só dispara se `isAdmin === false` no caminho JWT. Como o atacante controla o role, esse fallback nunca executa.

**Fix sugerido (ordem de preferência):**

A. **Verificar assinatura via Firebase/Google JWKS (PRODUÇÃO).**
   - GHL usa Firebase Auth — JWTs são RS256 assinados pelo Google. Usar `jose.createRemoteJWKSet("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")` (ou similar — Firebase publica JWKS).
   - `jwtVerify(idToken, JWKS, { issuer: "https://securetoken.google.com/<firebase-project-id>", audience: "<firebase-project-id>" })`.
   - Se Firebase do GHL é multi-tenant ou whitelabel-específico, descobrir o issuer via inspeção de um JWT real do Pedro.

B. **Plano B (interim, 1 dia de implementação):** remover totalmente o caminho `idToken` e confiar SÓ no GHL API (`validateGHLUser`). Aceita custo: agency users podem não aparecer em `/users/?locationId=...` — mas a alternativa atual é insegura.

C. **Mitigação parcial enquanto não vai prod:** adicionar shared secret no header (`X-Sparkbot-Origin-Token`) que loader.js sabe e que o atacante não consegue extrair sem injetar JS no GHL. NÃO substitui A/B mas reduz superfície enquanto está em desenvolvimento.

---

### HIGH

#### CVE-SB-002 — Token JWT em query string vaza via Referer header / browser history

**File:** `src/app/embed/sparkbot/loader/route.ts:364-365`, `src/app/embed/sparkbot/page.tsx:55-57`
**Severity:** HIGH

**Descrição:**
O loader.js injeta o iframe com `src = "/embed/sparkbot?token=" + encodeURIComponent(STATE.token)`. Esse JWT (1h TTL, full perms do rep) acaba em:
- **Browser history** (em alguns browsers — Chrome geralmente NÃO loga URLs de iframe na top-level history, mas o iframe próprio mantém history se navegação ocorrer).
- **Server access logs** (Vercel registra URL completa em logs por default — tem `?token=...` lá).
- **Referer header** quando o iframe faz qualquer navegação out-of-origin (link externo, fetch sem cors=no-referrer): nossa origem `spark-ai-platform.vercel.app` vai mandar Referer pro destino, contendo `?token=`.
- **Bug reports / screen-share** se o rep abrir DevTools e copiar a URL.
- **Crash dumps** do browser, Sentry-like services se configurados.

Iframe puro com `<iframe src=".../page?token=...">` não vaza Referer pra origem externa imediatamente — mas qualquer fetch interno do iframe vai (default browser behavior). Sparkbot/page.tsx usa `fetch("/api/sparkbot/...")` em mesma origem — OK. **Mas:** se o usuário clicar em qualquer link no chat (msg do agente com URL), o navegador mandará Referer com `?token=...` pra qualquer destino externo.

**Exploit scenario:**
1. Atacante consegue Sparkbot a gerar/incluir uma URL externa (ex: link de news search tool, ou prompt injection que gera `<a href="https://attacker.com">link</a>`).
2. Rep clica no link.
3. attacker.com recebe Referer header `https://spark-ai-platform.vercel.app/embed/sparkbot?token=<JWT-do-rep>`.
4. Atacante usa o token nos próximos 60 minutos.

Outros vetores: Vercel server logs vazam pra ops/devs (escopo interno — mas conta como "exposição não-mínima"); browser history de máquina compartilhada.

**Fix sugerido (ordem):**

A. **Trocar query → postMessage**: loader cria iframe SEM token na URL, depois faz `iframe.contentWindow.postMessage({ token, repName }, APP_URL)` quando iframe sinalizar pronto (`postMessage("ready", APP_URL)` do iframe). Token nunca toca URL.

B. **Mitigação interim**: adicionar `<meta name="referrer" content="no-referrer">` no `app/embed/sparkbot/layout.tsx` head (ou `Referrer-Policy: no-referrer` header no response). Mata o vetor Referer mas não resolve logs/history.

C. **Defesa em profundidade**: na app/embed/sparkbot/page.tsx, depois de ler o token, fazer `window.history.replaceState(null, "", window.location.pathname)` pra remover o token da URL visível. Não remove dos logs servidor mas remove do DevTools/browser history.

---

#### CVE-SB-003 — CORS `*` em todos endpoints sparkbot permite cross-origin abuse com token vazado

**File:** `src/app/api/sparkbot/check-admin/route.ts:27`, `src/app/api/sparkbot/send/route.ts:24`, `src/app/api/sparkbot/inbox/route.ts:22`, `src/app/api/sparkbot/transcribe/route.ts:23`
**Severity:** HIGH

**Descrição:**
Todos os endpoints usam `Access-Control-Allow-Origin: *`. Combinado com Bearer header (não cookie), CSRF clássico não aplica — MAS:

1. **Combinado com CVE-SB-001**: atacante anônimo pode chamar check-admin de qualquer lugar pra obter token. Se CORS fosse restritivo, o ataque ficaria limitado a sites confiáveis (defense-in-depth).

2. **Combinado com CVE-SB-002**: se o token vazar (Referer, history, social), atacante pode usar o token em fetch direto do browser dele — JS no `evil.com` consegue fetch `/api/sparkbot/send` com Bearer e ler resposta porque CORS é `*`.

3. **Phishing**: atacante hospeda site falso com formulário "Sparkbot login" que captura `userId`+`companyId`+ JWT do localStorage GHL via copy/paste de "instruções de debug", depois faz check-admin do servidor dele e usa o token. Um CORS restritivo bloquearia isso pelo browser do rep.

**Exploit scenario:**
- Phishing: "página de teste do Sparkbot" hospedada em `sparkbot-help.com`. Página contém JS que pede pro rep colar `localStorage.getItem('refreshedToken')`. Página manda pra check-admin do nosso servidor. Sem CORS restritivo, request passa.
- Token leak via CVE-SB-002: token captado em Referer; `evil.com` faz `fetch('https://spark-ai-platform.vercel.app/api/sparkbot/inbox', { headers: { Authorization: 'Bearer <leaked>' } })` direto do browser do atacante. Funciona sem CORS issues porque `*`.

**Fix sugerido:**

A. **Allowlist de origins** baseada em config:
   ```ts
   const ALLOWED_ORIGIN_PATTERNS = [
     /^https:\/\/app\.gohighlevel\.com$/,
     /^https:\/\/app\.sparkleads\.pro$/,
     /^https:\/\/.*\.gohighlevel-services\.com$/,
     /^https:\/\/spark-ai-platform\.vercel\.app$/,
     // White-labels descobertos: tabela location_settings.whitelabel_origin?
   ];
   const origin = request.headers.get("origin");
   const allowOrigin = origin && ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin)) ? origin : null;
   if (!allowOrigin) return 403;
   ```

B. **Como descobrir whitelabel domains:** GHL tem tabela `location_settings.whitelabel_domain` ou similar. Consultar no Supabase. Pra MVP, hardcode os 3-5 domains conhecidos do Pedro (sparkleads + outros que ele admin-eia) e adicionar via env var `ALLOWED_SPARKBOT_ORIGINS=...,...`.

C. **Endpoint check-admin pode manter CORS aberto SE outras vulns forem fechadas** (verificar JWT signature, etc) — mas `/send`, `/inbox`, `/transcribe` que rodam com Bearer válido devem ser restritos por origin ALÉM do Bearer.

---

#### CVE-SB-004 — Ausência total de rate limiting

**File:** todos os endpoints `/api/sparkbot/*` — não implementam rate limit
**Severity:** HIGH (financial DoS)

**Descrição:**
Nenhum dos 4 endpoints tem rate limiting. Combinado com CVE-SB-001 (1 atacante anônimo → token válido), ou mesmo sozinho (rep legítimo malicioso), 1 token pode:
- Mandar 1000 msgs/min em `/send` → cada msg dispara LLM (Claude/GPT-4) → drena `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` ou cobra location. Custo Claude Sonnet ~$3/1M tokens input = potencial $50-100/dia trivial.
- Submeter 25MB audios em loop em `/transcribe` → Whisper a $0.006/min, mas mais perigoso: pode vazar memória/disco se Vercel retiver buffers grandes.
- Polling `/inbox` em DDoS pattern → derruba app server.

**Exploit scenario:**
Rep insatisfeito (ou conta hijackada) escreve script: `setInterval(() => fetch('/api/sparkbot/send', { method:'POST', headers: { Authorization: 'Bearer <token>' }, body: JSON.stringify({ message: 'teste' }) }), 100)`. Token vale 1h → 36000 requests, cada disparando LLM.

**Fix sugerido:**

A. **Rate limit por rep_id no Redis/Upstash** (ou Vercel KV):
   - `/send`: 30 req/min, 200/hr.
   - `/transcribe`: 20 req/min, 100/hr.
   - `/inbox`: 60 req/min (heartbeat legítimo é 4/min via polling, dá margem).
   - `/check-admin`: 10 req/min por IP (mais agressivo — endpoint não-autenticado).

B. **Plano B sem Redis:** rate limit in-memory por instância (módulo `rate-limiter-flexible` mode in-memory) — não é escalável horizontal mas Vercel tipicamente roda 1-3 instâncias paralelas, OK pra MVP.

C. **Cap de billing por rep/dia** (defesa em profundidade): se rep_id passa $X/dia em LLM, retorna 429 com mensagem amigável.

---

### MEDIUM

#### CVE-SB-005 — Iframe sem `sandbox` attribute

**File:** `src/app/embed/sparkbot/loader/route.ts:362-366`
**Severity:** MEDIUM

**Descrição:**
O iframe é injetado sem `sandbox` attribute:
```js
var iframe = document.createElement("iframe");
iframe.src = APP_URL + "/embed/sparkbot?token=" + ...;
iframe.allow = "microphone; clipboard-write; notifications";
```

Sem sandbox, o iframe roda com privilégios full no domain `spark-ai-platform.vercel.app`. Se uma KB chunk maliciosa, ou prompt injection, conseguir injetar `<script>` que page.tsx renderize (não é o caso hoje porque React escapa — ver CVE-SB-006), o JS roda com permissões totais nesse domain — incluindo cookie do `spark_session` (httpOnly, mas não bloqueia mesmo-origin scripts de fazer requests autenticados).

**Exploit scenario:**
Hipotético: se algum dia adicionarmos `dangerouslySetInnerHTML` pra renderizar markdown do agente, sandbox seria a barreira. Hoje é defense-in-depth.

**Fix sugerido:**
```js
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
```
Cuidado: `allow-same-origin` é necessário pra fetch funcionar; sem ele, page.tsx bate em CORS contra a própria origem. `allow-modals`/`allow-downloads` opcional.

---

#### CVE-SB-006 — XSS em `repName` da URL (exposure muito baixa, defesa em profundidade)

**File:** `src/app/embed/sparkbot/page.tsx:57`, `:598`
**Severity:** LOW (verificado — React escapa)

**Descrição:**
`repName` vem da URL (`?repName=...`) e é renderizado em `<h2>Oi {repName.split(" ")[0]} 👋</h2>` (linha 598). React escapa por default — não há `dangerouslySetInnerHTML`. **Confirmado seguro.**

**Path de risco:** se algum dia trocar pra `<h2 dangerouslySetInnerHTML={{__html: `Oi ${repName}`}} />` (otimização de markdown, etc), vira XSS imediato porque atacante controla `?repName=<img src=x onerror=...>`.

Bubble (`page.tsx:693`) usa `<div className="content">{msg.content}</div>` — content do agente, mesmo se LLM gerar HTML, é tratado como texto (React escape). **Confirmado seguro.** `whitespace: pre-wrap` linha 736 mantém formatting visual mas não muda escaping.

**Fix sugerido (preventivo):**
- Adicionar comentário no código: `// SECURITY: NEVER use dangerouslySetInnerHTML for repName / msg.content — atacante controla via URL/LLM`.
- Limitar tamanho de `repName` (atualmente sem cap; mostrar só primeiros 30 chars defende contra UI breakage e injeção de muito HTML).

---

#### CVE-SB-007 — `idToken` mismatch loga claims em logs (exposure de PII)

**File:** `src/app/api/sparkbot/check-admin/route.ts:100-103`, linha 107
**Severity:** MEDIUM (privacy / log hygiene)

**Descrição:**
```ts
console.warn("[check-admin] idToken mismatch:", { matchesUser, matchesCompany, notExpired });
console.warn("[check-admin] idToken decode falhou:", e instanceof Error ? e.message : e);
```

Não logamos o JWT inteiro, mas em produção esses warns vão pro Vercel log — se mismatch for sistemático (ex: Pedro testando), há ruído. Não é crítico mas vale notar: se algum dia adicionarmos `console.warn(... payload)` (debug temporário), claims do Firebase contém PII (`email`, `name`, IDs internos do GHL).

**Fix sugerido:**
- Garantir que NUNCA logamos o `idToken` raw nem o `payload` decodificado completo. Audit existente passa.
- Adicionar comentário "SECURITY: never log idToken/payload" próximo das linhas.

---

#### CVE-SB-008 — `web_session_active_at` update sem await (race + silent fail)

**File:** `src/app/api/sparkbot/inbox/route.ts:53-58`, `src/app/api/sparkbot/send/route.ts:122-128`
**Severity:** LOW (functional, não security crítico)

**Descrição:**
Heartbeat usa `void supabase.from(...).update(...).eq(...)` sem await. Não é vuln security em si, mas:
- Erro silencioso (sem log) se RLS bloqueia ou coluna ausente.
- Race: dois GETs paralelos podem update na mesma row sem conflict — Supabase resolve por last-write-wins. OK.

**Fix sugerido:** marginal. Wrappar em `.catch(err => console.warn(...))` pra não silenciar erros completamente.

---

### LOW

#### CVE-SB-009 — JWT_SECRET reuso eterno, sem rotação

**File:** `src/lib/account-assistant/web-auth.ts:23-27`, `src/lib/auth/sso.ts:10-14`
**Severity:** LOW (operational hygiene)

**Descrição:**
`JWT_SECRET` é a mesma env var usada pra `/api/auth/*` (cookie session) e pra `/api/sparkbot/*`. Se um dia o secret leakar (commit acidental, log dump, ex-funcionário), todos JWTs ativos ficam comprometidos (1h TTL pro Sparkbot, 24h pro spark_session).

Não há mecanismo de rotação. `signSparkbotWebToken` não inclui `kid` (key ID), então não conseguimos rotação gradual com 2 secrets ativos.

**Fix sugerido (não-urgente):**
- Documentar processo de rotação: `JWT_SECRET_NEXT` env var, deploy, depois `JWT_SECRET=<new>`, deploy de novo. Aceita janela de 1h onde tokens emitidos antes da rotação ficam inválidos (rep precisa reload do GHL — não causa data loss).
- Long-term: incluir `kid` no protected header e suportar 2 secrets.

---

#### CVE-SB-010 — Logout do GHL não invalida JWT do Sparkbot

**File:** conceitual — `loader/route.ts` + `web-auth.ts`
**Severity:** LOW

**Descrição:**
Se Pedro/rep deslogar do GHL, o `refreshedToken` no localStorage é (geralmente) limpo pelo GHL — mas o JWT que **NÓS emitimos** continua válido por até 1h. Se atacante já capturou esse JWT (CVE-SB-002) ou se a máquina é compartilhada, deslogar do GHL não revoga acesso ao Sparkbot.

**Exploit scenario:**
- Rep usa máquina compartilhada (escritório). Logout do GHL. Próxima pessoa não consegue acesso ao GHL próprio (sessão GHL invalidada), mas se ela tiver capturado o JWT do Sparkbot do rep anterior (cache, history, log), tem 1h de acesso.

**Fix sugerido:**
- Tabela `sparkbot_active_sessions(jwt_id, rep_id, created_at, revoked_at)`. signSparkbotWebToken inclui `jti` (JWT ID), endpoint check verifica se `revoked_at` IS NULL.
- Endpoint `/api/sparkbot/logout` que revoga.
- TTL atual de 1h é mitigação parcial — OK pra MVP, não pra enterprise.

---

#### CVE-SB-011 — sso.ts `isUserAdmin` aceita `role === "user"` como admin

**File:** `src/lib/auth/sso.ts:79`
**Severity:** LOW (não exposto via Sparkbot, mas é bug de outro caminho)

**Descrição:**
```ts
function isUserAdmin(user: GHLUser): boolean {
  return (
    role === "admin" ||
    role === "user" ||  // ← isso é bug
    role === "owner" ||
    ...
  );
}
```

`role === "user"` significa "qualquer usuário GHL é considerado admin". Bug existente do SSO legacy. **Não é exploitável via Sparkbot porque o caminho JWT-claims (CVE-SB-001) ataca antes** e usa `adminRoles = ["admin", "owner", "agency_owner", "agency_user"]` (não inclui "user"). Mas se um dia removermos o caminho JWT (após fix CVE-SB-001), isso vira bypass.

**Fix sugerido:** remover `role === "user"` da função. Verificar quem chama isUserAdmin antes pra não quebrar SSO existente.

---

## Hardening recomendado (ordem de prioridade)

### Fase 1 — antes de >5 reps em produção (1-3 dias)

1. **[CRITICAL] Verificar assinatura JWT do Firebase** (CVE-SB-001).
   - Identificar Firebase project ID do GHL/sparkleads. Conseguir um JWT real do Pedro pra inspecionar issuer/audience.
   - Implementar `verifyFirebaseIdToken(idToken)` usando `jose.createRemoteJWKSet` + `jwtVerify`.
   - Rejeitar `check-admin` se assinatura inválida (não fallback silencioso).
   - Fallback se Firebase JWKS estiver indisponível: SOMENTE GHL API.

2. **[HIGH] Restringir CORS** (CVE-SB-003).
   - Hardcode lista inicial: `app.gohighlevel.com`, `app.sparkleads.pro`, `spark-ai-platform.vercel.app`, possivelmente `*.gohighlevel-services.com`.
   - Env var `SPARKBOT_ALLOWED_ORIGINS` pra adicionar whitelabels sem deploy.

3. **[HIGH] Rate limit** (CVE-SB-004).
   - Mínimo: in-memory limit por rep_id (`/send`: 30/min, `/transcribe`: 20/min). Vercel KV ou Upstash Redis pra produção.

4. **[HIGH] Tirar token da URL** (CVE-SB-002).
   - Trocar `?token=` → postMessage do loader pro iframe.
   - Adicionar `Referrer-Policy: no-referrer` no embed/sparkbot/layout.tsx response (interim).

### Fase 2 — hardening adicional (3-5 dias)

5. **[MED] Iframe sandbox** (CVE-SB-005).
6. **[MED] Audit de logging** — garantir nenhum endpoint loga JWT/idToken/PII (CVE-SB-007).
7. **[LOW] Limitar tamanho de `repName`** (CVE-SB-006 preventivo).
8. **[LOW] Fix `role === "user"` em sso.ts** (CVE-SB-011).

### Fase 3 — long-term

9. **[LOW] Revogação ativa de JWT** via tabela `sparkbot_active_sessions` (CVE-SB-010).
10. **[LOW] Suporte a rotação de JWT_SECRET** com `kid` (CVE-SB-009).
11. **CSP no embed/sparkbot**: `Content-Security-Policy: default-src 'self'; connect-src 'self' https://api.openai.com; ...` no header da response. Defense em profundidade contra XSS.
12. **Auditoria de tools do Sparkbot**: tools como `create_note`, `create_task` operam em contatos do CRM. Garantir que `tok.location_id` tá usado como filtro em TODAS as queries (verificar processIncoming + tools handlers — fora do escopo deste review).

---

## OK status — práticas que estão certas

Importante notar o que tá bem feito (não mexer):

- **Bearer header em vez de cookie pra Sparkbot Web** (`web-auth.ts:14-16`). Decisão correta — elimina CSRF clássico, simplifica CORS cross-origin (GHL→nossa API).

- **TTL curto de 1h** (`web-auth.ts:21`). Mitiga vazamento. Aceita custo de re-auth.

- **`signSparkbotWebToken` separado de `createSession`** (web-auth.ts:39). Não reusa o cookie session pro web embed — bom isolamento.

- **`maybeSingle()` em queries** (check-admin:50). Consistente, evita 500 quando rep não existe.

- **Heartbeat fire-and-forget** (`inbox/route.ts:55-58`). Performance correta — não bloqueia GET principal.

- **Limite de 25MB no upload de áudio** (`transcribe/route.ts:46-48`). Match com Whisper limit, defensivo.

- **Limite de 100 bytes minimum no áudio** (`transcribe/route.ts:49-51`). Bloqueia uploads vazios/garbled.

- **`metadata: { ghl_user_id }` persistido em messages** (send/route.ts:108). Audit trail correto.

- **`channel='web_ui'` separa msgs web de WhatsApp** (send/route.ts:138). Permite politicas diferentes (ex: msgs proativas só fluem pra web se rep tá ativo lá).

- **`Suspense` wrapper no Page** (page.tsx:777-783). Evita hydration errors com URL params.

- **React escape automático em `{msg.content}` e `{repName}`** (page.tsx:598, 693). Sem `dangerouslySetInnerHTML` em lugar nenhum — bom.

- **`onstop = null` em cancelRecording** (page.tsx:184). Skip upload corretamente quando cancela.

- **Comentário documentando trade-off do JWT sem verify** (check-admin:67-70). Embora a decisão seja errada, pelo menos foi consciente — facilita revisão.

- **`only_unread` filter parametrizado**, não hardcoded (`inbox/route.ts:49`). Permite UX flexível.

- **Loader.js: `window.__sparkbotInjected` guard** (loader:55-56). Idempotente — não duplica botão se Custom JS roda 2x.

- **Loader.js: `STATE.token` em closure JS** (loader:62). Não persiste em localStorage — boa decisão (limita exposure).

- **Loader.js: detecta SPA navigation e re-autentica em location change** (loader:550-561). Mantém token consistente com contexto atual.

- **`__sparkbotDebug()` exposto em `window`** (loader:525-547). Bom DX — Pedro consegue debugar sem precisar de backend.

- **CORS preflight (OPTIONS) implementado em todos endpoints** (check-admin:33, send:29, etc). Embora `Allow-Origin: *` seja problema (CVE-SB-003), pelo menos a mecânica de preflight tá correta.

---

## Métricas

- **Vulnerabilidades:** 1 CRITICAL, 3 HIGH, 4 MEDIUM, 3 LOW = **11 total**
- **Arquivos auditados:** 8 (loader, page, layout, 4 endpoints, web-auth, sso)
- **LOC auditadas:** ~1900
- **Risco residual após Fase 1:** baixo-médio (sandbox/CSP ajudam mas não são bloqueadores).

**Verdict:** **bloquear rollout pra >5 reps até CVE-SB-001 ser fechado**. Resto pode ser sequenciado em sprints normais.
