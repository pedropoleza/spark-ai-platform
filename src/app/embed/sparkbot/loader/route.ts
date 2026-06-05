/**
 * GET /embed/sparkbot/loader.js
 *
 * Serve o JS dinâmico que Pedro injeta no GHL via Agency Settings →
 * Custom JavaScript. O snippet pequeno (5 linhas) que Pedro cola só
 * carrega ESTE arquivo — assim a gente atualiza o comportamento do widget
 * sem o Pedro tocar no GHL nunca mais.
 *
 * O que esse JS faz:
 *   1. Detecta que está numa página do GHL e extrai locationId + companyId
 *      da URL (/v2/location/<id>/...) e userId via API GHL me-endpoint
 *   2. POST /api/sparkbot/check-admin com esses dados → JWT + repId
 *   3. Se admin, injeta:
 *      - Botão flutuante no header (com badge de unread)
 *      - Painel deslizante 450px à direita com iframe pro chat
 *   4. Polling de inbox a cada 15s (heartbeat + unread badge)
 *   5. Notificação browser quando msg proativa chega (com permissão)
 *
 * Cache: pequeno (5min) — evita atualizações instantâneas pro Pedro mas
 * permite hotfix relativamente rápido. Sem cache em desenvolvimento.
 */

import { NextResponse } from "next/server";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://spark-ai-platform.vercel.app";
const POLL_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export async function GET() {
  const script = buildLoaderScript();
  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Sem cache: queremos que mudanças apareçam imediatamente sem o
      // Pedro ter que limpar cache. Browsers ainda revalidam (304 ETag).
      // Custo: 1 request/page-load — irrelevante.
      "Cache-Control": "no-cache, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function buildLoaderScript(): string {
  // Embedded as a single IIFE. Cada `__VAR__` é um placeholder substituído
  // server-side pra não vazar URL/intervalos nos comentários do navegador.
  //
  // NOTA: já tentamos substituir todos `<` por `<` pra evitar o
  // postscribe do GHL parsear como HTML, mas isso quebra operadores JS
  // válidos (ex: `if (i < 5)`) porque JS não permite escape unicode em
  // operadores. A solução foi mudar o snippet do GHL pra usar
  // `fetch + new Function(code)` em vez de `<script src=>` — assim o
  // postscribe não processa o body do loader.
  //
  // GU-2 (2026-06-04): concatenamos um SEGUNDO IIFE independente
  // (AGENT_CONTROLS_SOURCE) — os controles do agente lead-facing na tela de
  // contato (pill liga/desliga). É isolado de propósito: o IIFE do SparkBot
  // (provado) fica intocado; o de controles tem auth própria (/api/agents/ui-auth,
  // que aceita qualquer user válido da location, não só admin) e estado próprio.
  // Um snippet só pro Pedro colar; dois módulos servidos.
  return (LOADER_SOURCE + "\n;\n" + AGENT_CONTROLS_SOURCE)
    .replaceAll("__APP_URL__", APP_URL)
    .replaceAll("__POLL_INTERVAL_MS__", String(POLL_INTERVAL_MS))
    .replaceAll("__HEARTBEAT_INTERVAL_MS__", String(HEARTBEAT_INTERVAL_MS));
}

const LOADER_SOURCE = `(function () {
  // Reentrância: snippet do GHL Custom JS pode setar __sparkbotInjected
  // antes do fetch+Function completar. Aceita re-execução se loader ainda
  // não foi totalmente carregado (debug fn ainda undefined).
  if (window.__sparkbotInjected && typeof window.__sparkbotDebug === "function") return;
  window.__sparkbotInjected = true;

  var APP_URL = "__APP_URL__";
  var POLL_MS = __POLL_INTERVAL_MS__;
  var HEARTBEAT_MS = __HEARTBEAT_INTERVAL_MS__;
  var STATE = {
    token: null,
    repId: null,
    repName: "",
    locationId: null,
    companyId: null,
    userId: null,
    panelOpen: false,
    unread: 0,
    lastSeenIds: new Set(),
    notificationGranted: false,
  };

  // ---------- Detect GHL context ----------
  function detectLocationId() {
    var match = location.pathname.match(/\\/v2\\/location\\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  // Cacheia o claims do JWT pra não decodificar 4x
  var __ghlClaims = null;
  function getGhlClaims() {
    if (__ghlClaims) return __ghlClaims;
    // Chaves conhecidas (em ordem de preferência):
    //   - 'refreshedToken' (white-label sparkleads + GHL atual): JSON envelope
    //     { refreshedToken: { claims: { user_id, company_id, role, ... } } }
    //   - 'token-id' / 'ghl_user_token' (legado): JWT direto
    var keys = ["refreshedToken", "token-id", "ghl_user_token"];
    for (var i = 0; i < keys.length; i++) {
      var raw = localStorage.getItem(keys[i]);
      if (!raw) continue;
      // Tenta como JSON envelope primeiro (refreshedToken pattern)
      try {
        var parsed = JSON.parse(raw);
        // Caso A: { refreshedToken: { claims: {...} } } — sparkleads atual
        if (parsed && parsed.refreshedToken && parsed.refreshedToken.claims) {
          __ghlClaims = parsed.refreshedToken.claims;
          return __ghlClaims;
        }
        // Caso B: { claims: {...} } direto
        if (parsed && parsed.claims) {
          __ghlClaims = parsed.claims;
          return __ghlClaims;
        }
      } catch (e) {}
      // Tenta como JWT direto (formato xxx.yyy.zzz)
      try {
        var parts = raw.split(".");
        if (parts.length === 3) {
          var payload = JSON.parse(atob(parts[1]));
          if (payload.claims) { __ghlClaims = payload.claims; return __ghlClaims; }
          // Algumas versões expõem direto no payload
          if (payload.user_id || payload.userId || payload.sub) {
            __ghlClaims = payload;
            return __ghlClaims;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function detectCompanyId() {
    var c = getGhlClaims();
    if (c) {
      if (c.company_id) return c.company_id;
      if (c.companyId) return c.companyId;
    }
    // Fallbacks
    try { if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.companyId) return window.__INITIAL_STATE__.companyId; } catch (e) {}
    try { if (window.app && window.app.companyId) return window.app.companyId; } catch (e) {}
    var meta = document.querySelector('meta[name="company-id"]');
    if (meta) return meta.getAttribute("content");
    return null;
  }

  function detectUserId() {
    var c = getGhlClaims();
    if (c) {
      if (c.user_id) return c.user_id;
      if (c.userId) return c.userId;
      if (c.uid) return c.uid;
      if (c.sub) return c.sub;
    }
    // Fallbacks (alguns white-labels antigos)
    try { if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user) return window.__INITIAL_STATE__.user.id; } catch (e) {}
    try { if (window.app && window.app.user && window.app.user.id) return window.app.user.id; } catch (e) {}
    return null;
  }

  // ---------- Auth ----------
  function authenticate() {
    var locationId = detectLocationId();
    var companyId = detectCompanyId();
    var userId = detectUserId();
    if (!locationId || !companyId || !userId) {
      console.warn("[Sparkbot] não consegui extrair contexto GHL", { locationId: locationId, companyId: companyId, userId: userId });
      return Promise.resolve(false);
    }

    STATE.locationId = locationId;
    STATE.companyId = companyId;
    STATE.userId = userId;

    // Envia também o idToken (refreshedToken do localStorage GHL). Server
    // verifica RS256 via Firebase JWKS público — fonte confiável vs GHL API
    // (que não retorna agency users em /users/?locationId=...).
    //
    // refreshedToken pode estar JSON-stringified (com aspas extras) no
    // localStorage do GHL/sparkleads. Tenta parse, fallback pro raw.
    var idToken = null;
    try {
      var raw = localStorage.getItem("refreshedToken");
      if (raw) {
        if (raw.startsWith('"')) {
          try { idToken = JSON.parse(raw); } catch (e) { idToken = raw; }
        } else {
          idToken = raw;
        }
      }
    } catch (e) {}

    return fetch(APP_URL + "/api/sparkbot/check-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userId,
        locationId: locationId,
        companyId: companyId,
        locationName: detectLocationName(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        idToken: idToken,
      }),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        console.log("[Sparkbot] não autorizado:", data.reason);
        return false;
      }
      STATE.token = data.token;
      STATE.repId = data.rep.id;
      STATE.repName = data.rep.name || "";
      return true;
    })
    .catch(function (err) {
      console.warn("[Sparkbot] check-admin falhou:", err && err.message);
      return false;
    });
  }

  function detectLocationName() {
    var sel = document.querySelector(".hl_header--picker .selected, .hl_header--picker .filter-option-inner-inner");
    return sel ? (sel.textContent || "").trim() : null;
  }

  // ---------- UI: header button + panel ----------
  function injectStyles() {
    if (document.getElementById("sparkbot-styles")) return;
    var css = \`
      /* Botão inline no header — Spark blue, mesmo formato dos outros círculos */
      .sparkbot-btn {
        position: relative;
        width: 36px; height: 36px; border-radius: 50%;
        background: linear-gradient(135deg, #1675F2 0%, #2980F2 100%);
        box-shadow: 0 2px 10px rgba(22, 117, 242, 0.32);
        display: inline-flex; align-items: center; justify-content: center;
        cursor: pointer; border: none;
        transition: transform 0.18s ease, box-shadow 0.18s ease;
        font-family: system-ui, -apple-system, sans-serif;
        margin: 0 6px; flex-shrink: 0;
        vertical-align: middle;
        overflow: visible;
      }
      .sparkbot-btn:hover {
        transform: scale(1.07);
        box-shadow: 0 4px 16px rgba(22, 117, 242, 0.45);
      }
      .sparkbot-btn svg { width: 22px; height: 22px; }
      .sparkbot-btn .sparkbot-badge {
        position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
        padding: 0 5px; background: #ef4444; color: white; border-radius: 9px;
        font-size: 10px; font-weight: 700; display: flex; align-items: center;
        justify-content: center; border: 2px solid white;
      }
      .sparkbot-btn.sparkbot-floating {
        position: fixed; right: 20px; bottom: 20px; z-index: 999998;
        width: 56px; height: 56px; margin: 0;
      }
      .sparkbot-btn.sparkbot-floating svg { width: 32px; height: 32px; }
      .sparkbot-btn.sparkbot-floating .sparkbot-badge {
        top: -4px; right: -4px; min-width: 20px; height: 20px; font-size: 11px;
      }
      #sparkbot-panel {
        position: fixed; top: 0; right: 0; bottom: 0; width: 460px;
        max-width: 100vw; z-index: 999999;
        background: white;
        box-shadow:
          -8px 0 32px rgba(15, 23, 42, 0.12),
          -2px 0 8px rgba(15, 23, 42, 0.06);
        transform: translateX(100%);
        transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex; flex-direction: column;
        font-family: 'Open Sans', system-ui, -apple-system, sans-serif;
      }
      #sparkbot-panel.open { transform: translateX(0); }
      #sparkbot-panel-close {
        position: absolute;
        top: 12px; right: 12px;
        background: rgba(15, 23, 42, 0.04);
        border: 0; color: #475569; cursor: pointer;
        width: 28px; height: 28px; border-radius: 50%;
        font-size: 18px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s;
        z-index: 10;
      }
      #sparkbot-panel-close:hover {
        background: rgba(15, 23, 42, 0.08);
        color: #0f172a;
      }
      #sparkbot-panel iframe {
        flex: 1; border: 0; width: 100%;
      }
      @media (max-width: 600px) {
        #sparkbot-panel { width: 100vw; }
      }
    \`;
    var style = document.createElement("style");
    style.id = "sparkbot-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * Tenta achar o container ideal pro botão (dentro do header GHL).
   * Ordem de tentativas (do mais específico pro genérico):
   *   1. .hl_header--controls (container conhecido dos ícones de cima)
   *   2. .hl_header__nav, .hl_header
   *   3. nav[role="navigation"]
   * Retorna null se nenhum bater — caller usa floating fallback.
   */
  function findHeaderContainer() {
    var candidates = [
      ".hl_header--controls",
      ".hl_header .controls",
      ".hl_header__controls",
      ".hl_header__right",
      ".hl_header",
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el) return el;
    }
    return null;
  }

  function injectFab() {
    // Se já existe (de tentativa anterior), não duplica
    if (document.querySelector(".sparkbot-btn")) return true;

    var btn = document.createElement("button");
    btn.className = "sparkbot-btn";
    btn.title = "SparkBot — copiloto IA";
    btn.setAttribute("aria-label", "Abrir SparkBot");
    // Mascote robô — versão simplificada do que aparece no painel.
    // Branco translúcido sobre o gradient azul.
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
        '<line x1="12" y1="3" x2="12" y2="6" stroke="white" stroke-width="1.6" stroke-linecap="round"/>',
        '<circle cx="12" cy="2.5" r="1.1" fill="white"/>',
        '<rect x="5" y="6" width="14" height="12" rx="4.5" fill="white" fill-opacity="0.95"/>',
        '<rect x="7.5" y="8.5" width="9" height="6" rx="2.5" fill="#0E54B0"/>',
        '<circle cx="10" cy="11.5" r="1.2" fill="#9be3ff"/>',
        '<circle cx="14" cy="11.5" r="1.2" fill="#9be3ff"/>',
        '<path d="M10.5 13.6 Q12 14.4 13.5 13.6" stroke="#5eb5ff" stroke-width="0.9" stroke-linecap="round" fill="none"/>',
      '</svg>'
    ].join("");
    btn.onclick = togglePanel;

    // 1) Tenta inline no header (preferido — fica do lado dos outros botões)
    var header = findHeaderContainer();
    if (header) {
      // Insere ANTES do avatar/dropdown (que costuma ser o último child).
      // Se acharmos o avatar, prependamos antes dele; senão, append no fim
      // (ainda visível, só fica depois dos demais).
      var avatar = header.querySelector(".hl_header--avatar, .hl_header--dropdown");
      if (avatar) header.insertBefore(btn, avatar);
      else header.appendChild(btn);
      console.log("[Sparkbot] botão injetado no header GHL");
      return true;
    }

    // 2) Fallback: floating no canto inferior direito (caso GHL mude markup)
    btn.classList.add("sparkbot-floating");
    document.body.appendChild(btn);
    console.warn("[Sparkbot] header GHL não encontrado — usando fallback flutuante");
    return true;
  }

  function injectPanel() {
    if (document.getElementById("sparkbot-panel")) return;
    var panel = document.createElement("div");
    panel.id = "sparkbot-panel";

    // Botão fechar flutuante (sobreposto ao header do painel SPA, no topo
    // direito). O painel SPA tem seu próprio header com mascote/branding.
    var close = document.createElement("button");
    close.id = "sparkbot-panel-close";
    close.innerHTML = "&times;";
    close.onclick = togglePanel;
    close.setAttribute("aria-label", "Fechar SparkBot");

    var iframe = document.createElement("iframe");
    iframe.id = "sparkbot-iframe";
    iframe.src = APP_URL + "/embed/sparkbot?token=" + encodeURIComponent(STATE.token) +
                 "&repName=" + encodeURIComponent(STATE.repName);
    iframe.allow = "microphone; clipboard-write; notifications";
    // Sandbox attribute (Pedro 2026-05-04): isola execução do iframe.
    // - allow-scripts: necessário (Next.js + interatividade)
    // - allow-same-origin: necessário (fetch ao próprio app, localStorage)
    // - allow-forms + allow-popups: pra UX (link wa.me, copy etc)
    // - allow-modals: pra dialogs do Next/UI
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");

    panel.appendChild(close);
    panel.appendChild(iframe);
    document.body.appendChild(panel);
  }

  function togglePanel() {
    var panel = document.getElementById("sparkbot-panel");
    if (!panel) {
      injectPanel();
      panel = document.getElementById("sparkbot-panel");
      // Wait next frame pra aplicar transition
      requestAnimationFrame(function () { panel.classList.add("open"); });
    } else {
      panel.classList.toggle("open");
    }
    STATE.panelOpen = panel.classList.contains("open");
    if (STATE.panelOpen) {
      // Marca msgs lidas no servidor
      markAllRead();
      updateBadge(0);
      requestNotificationPermission();
    }
  }

  function updateBadge(count) {
    STATE.unread = count;
    var fab = document.querySelector(".sparkbot-btn");
    if (!fab) return;
    var existing = fab.querySelector(".sparkbot-badge");
    if (count > 0) {
      if (!existing) {
        var b = document.createElement("span");
        b.className = "sparkbot-badge";
        fab.appendChild(b);
        existing = b;
      }
      existing.textContent = count > 99 ? "99+" : String(count);
    } else if (existing) {
      existing.remove();
    }
  }

  // ---------- Notifications ----------
  function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      STATE.notificationGranted = true;
      return;
    }
    if (Notification.permission === "denied") return;
    Notification.requestPermission().then(function (perm) {
      STATE.notificationGranted = perm === "granted";
    });
  }

  function notify(msg) {
    if (!STATE.notificationGranted) return;
    if (!("Notification" in window)) return;
    try {
      var n = new Notification("Sparkbot", {
        body: msg.content.slice(0, 200),
        tag: "sparkbot-" + msg.id,
        icon: APP_URL + "/favicon.ico",
      });
      n.onclick = function () {
        window.focus();
        if (!STATE.panelOpen) togglePanel();
        n.close();
      };
    } catch (e) {}
  }

  // ---------- Polling ----------
  function poll() {
    if (!STATE.token) return;
    fetch(APP_URL + "/api/sparkbot/inbox?only_unread=1&limit=10", {
      headers: { Authorization: "Bearer " + STATE.token },
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) return;
      updateBadge(data.unread_count || 0);
      // Notifica msgs novas que ainda não vimos
      (data.messages || []).forEach(function (m) {
        if (!STATE.lastSeenIds.has(m.id) && m.is_proactive) {
          notify(m);
        }
        STATE.lastSeenIds.add(m.id);
      });
    })
    .catch(function () {});
  }

  function markAllRead() {
    if (!STATE.token) return;
    fetch(APP_URL + "/api/sparkbot/inbox", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + STATE.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message_ids: [] }),
    }).catch(function () {});
  }

  // Heartbeat (independent of polling — keep web_session_active_at fresh)
  function heartbeat() {
    if (!STATE.token) return;
    fetch(APP_URL + "/api/sparkbot/inbox?limit=1", {
      headers: { Authorization: "Bearer " + STATE.token },
    }).catch(function () {});
  }

  // ---------- Boot ----------
  function boot() {
    console.log("[Sparkbot] boot() iniciado");
    // Wait pra GHL terminar o initial load (URL pode ainda não ter locationId)
    var attempts = 0;
    var iv = setInterval(function () {
      attempts++;
      var loc = detectLocationId();
      var usr = detectUserId();
      var co = detectCompanyId();
      if (attempts === 1 || attempts === 5 || attempts === 15) {
        console.log("[Sparkbot] tentativa " + attempts + ":", { locationId: loc, userId: usr, companyId: co });
      }
      if (loc && usr && co) {
        clearInterval(iv);
        authenticate().then(function (ok) {
          if (!ok) {
            console.warn("[Sparkbot] não autenticado (não-admin ou erro)");
            return;
          }
          console.log("[Sparkbot] autenticado como", STATE.repName || STATE.repId);
          injectStyles();
          injectFab();
          poll();
          setInterval(poll, POLL_MS);
          setInterval(heartbeat, HEARTBEAT_MS);
          // Watcher: GHL pode re-renderizar o header em SPA navigation,
          // matando nosso botão. Re-injeta a cada 3s se sumir.
          setInterval(function () {
            if (!document.querySelector(".sparkbot-btn")) {
              injectFab();
            }
          }, 3000);
        });
      }
      if (attempts > 30) {
        clearInterval(iv);
        console.warn("[Sparkbot] desistindo após 30 tentativas — não consegui detectar contexto GHL", { locationId: loc, userId: usr, companyId: co });
      }
    }, 1000);
  }

  // Helper de debug exposto no window pro Pedro inspecionar:
  // > __sparkbotDebug()
  window.__sparkbotDebug = function () {
    return {
      injected: !!document.querySelector(".sparkbot-btn"),
      panel_open: STATE.panelOpen,
      authenticated: !!STATE.token,
      rep_name: STATE.repName,
      rep_id: STATE.repId,
      location_id: STATE.locationId,
      company_id: STATE.companyId,
      user_id: STATE.userId,
      unread: STATE.unread,
      header_found: !!findHeaderContainer(),
      header_selector: (function () {
        var el = findHeaderContainer();
        return el ? el.className : null;
      })(),
      detected: {
        locationId: detectLocationId(),
        userId: detectUserId(),
        companyId: detectCompanyId(),
      },
    };
  };

  // SPA navigation: re-detecta location quando muda URL (GHL é Vue SPA)
  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      var newLoc = detectLocationId();
      if (newLoc && newLoc !== STATE.locationId) {
        // Location mudou — refaz auth pra novo contexto
        STATE.token = null;
        authenticate();
      }
    }
  }, 2000);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("DOMContentLoaded", boot);
  }
})();`;

/**
 * MÓDULO agent-controls (GU-2) — IIFE independente, concatenado ao loader.
 *
 * Mostra na TELA DE CONTATO do Spark Leads (/contacts/detail/{id}) um pill
 * "Agente IA: LIGADO/DESLIGADO" quando o contato tem agente lead-facing ativo.
 * Clica → confirma → liga/desliga o agente pra aquele contato (fonte da verdade
 * = conversation_state.ai_paused_at, via /api/agents/contact-pause). É o botão
 * standalone que o Pedro pediu (NÃO depende do campo "AI Status" do GHL).
 *
 * Isolamento: estado/auth próprios (não compartilha nada com o IIFE do SparkBot
 * acima). Auth via /api/agents/ui-auth (qualquer user válido da location). Tudo
 * em try/catch + namespacing #spark-agent-pill / .sap-* + kill-switch
 * window.__SPARK_AGENT_CONTROLS_OFF — aditivo, não pode quebrar o GHL do cliente.
 *
 * Feedback por mensagem (👍/👎) é GU-3 (tela ofuscada — vem depois). GU-2 só faz
 * o pill de liga/desliga na tela de contato. Conversations screen = GU-4.
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md
 */
const AGENT_CONTROLS_SOURCE = `(function () {
  if (window.__sparkAgentControlsInit) return;
  window.__sparkAgentControlsInit = true;

  var APP_URL = "__APP_URL__";
  var TICK_MS = 1500;
  var REINJECT_MS = 3000;
  var AC = {
    token: null,
    authedLocation: null,
    authPromise: null,
    locationId: null, companyId: null, userId: null,
    contactId: null, statusLoaded: false,
    hasAgent: false, agentId: null, agentName: null, agentType: null, paused: false, reason: null,
    aiTexts: null, aiContactId: null, // GU-3: textos que a IA mandou (anti-eco p/ marcar bolhas)
    resolvedContactId: null, resolvedForConvId: null, resolvePromise: null, // GU-4: conv→contato
    agents: [], activeAgentId: null, iconState: "idle", // GU-7: seletor único + cor do ícone
  };

  // ---------- Detecção de contexto (resiliente, SPA) ----------
  function acLoc() { var m = location.pathname.match(/\\/v2\\/location\\/([A-Za-z0-9]+)/); return m ? m[1] : null; }
  function acContact() { var m = location.pathname.match(/\\/contacts\\/detail\\/([A-Za-z0-9]+)/); return m ? m[1] : null; }
  // GU-4: tela de Conversations — a URL tem conversationId, não contactId.
  function acConvId() { var m = location.pathname.match(/\\/conversations\\/conversations\\/([A-Za-z0-9]+)/); return m ? m[1] : null; }
  // Contato EFETIVO da tela atual: contact-detail direto OU o resolvido da conversa.
  function acCurrentContact() {
    var direct = acContact();
    if (direct) return direct;
    var cv = acConvId();
    if (cv && AC.resolvedForConvId === cv) return AC.resolvedContactId;
    return null;
  }
  // Resolve conversationId → contactId (cache + de-dupe). Re-dispara o tick ao resolver.
  function acResolveConvContact(cv) {
    if (!cv || !AC.token || AC.resolvedForConvId === cv || AC.resolvePromise) return;
    AC.resolvePromise = fetch(APP_URL + "/api/agents/conversation-contact?conversationId=" + encodeURIComponent(cv), {
      headers: { Authorization: "Bearer " + AC.token },
    })
      .then(function (r) { if (r.status === 401) { AC.token = null; return null; } return r.json(); })
      .then(function (d) {
        AC.resolvePromise = null;
        if (d && d.ok && d.contactId) { AC.resolvedContactId = d.contactId; AC.resolvedForConvId = cv; acTick(); }
      })
      .catch(function (e) { AC.resolvePromise = null; console.warn("[spark-agent] conv->contato erro:", e && e.message); });
  }

  function acClaims() {
    var keys = ["refreshedToken", "token-id", "ghl_user_token"];
    for (var i = 0; i < keys.length; i++) {
      var raw = localStorage.getItem(keys[i]); if (!raw) continue;
      try {
        var p = JSON.parse(raw);
        if (p && p.refreshedToken && p.refreshedToken.claims) return p.refreshedToken.claims;
        if (p && p.claims) return p.claims;
      } catch (e) {}
      try {
        var parts = raw.split(".");
        if (parts.length === 3) {
          var pl = JSON.parse(atob(parts[1]));
          if (pl.claims) return pl.claims;
          if (pl.user_id || pl.userId || pl.sub) return pl;
        }
      } catch (e) {}
    }
    return null;
  }
  function acCompany() { var c = acClaims(); if (c) { if (c.company_id) return c.company_id; if (c.companyId) return c.companyId; } return null; }
  function acUser() { var c = acClaims(); if (c) { if (c.user_id) return c.user_id; if (c.userId) return c.userId; if (c.uid) return c.uid; if (c.sub) return c.sub; } return null; }
  function acIdToken() {
    try {
      var raw = localStorage.getItem("refreshedToken");
      if (!raw) return null;
      if (raw.charAt(0) === '"') { try { return JSON.parse(raw); } catch (e) { return raw; } }
      return raw;
    } catch (e) { return null; }
  }

  // ---------- Auth (token per-location, reusado) ----------
  function acAuthenticate() {
    var loc = acLoc();
    if (AC.token && AC.authedLocation === loc) return Promise.resolve(true);
    if (AC.authPromise) return AC.authPromise;
    var co = acCompany(), usr = acUser(), idt = acIdToken();
    if (!loc || !co || !usr) return Promise.resolve(false);
    AC.locationId = loc; AC.companyId = co; AC.userId = usr;
    AC.authPromise = fetch(APP_URL + "/api/agents/ui-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: usr, locationId: loc, companyId: co, idToken: idt }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        AC.authPromise = null;
        if (!d || !d.ok) { console.warn("[spark-agent] ui-auth falhou:", d && d.reason); return false; }
        AC.token = d.token; AC.authedLocation = loc;
        console.log("[spark-agent] autenticado (admin=" + d.isAdmin + ")");
        return true;
      })
      .catch(function (e) { AC.authPromise = null; console.warn("[spark-agent] ui-auth erro:", e && e.message); return false; });
    return AC.authPromise;
  }

  function acFetchStatus(cid) {
    if (!AC.token) return Promise.resolve(null);
    return fetch(APP_URL + "/api/agents/contact-status?contactId=" + encodeURIComponent(cid), {
      headers: { Authorization: "Bearer " + AC.token },
    })
      .then(function (r) { if (r.status === 401) { AC.token = null; return null; } return r.json(); })
      .catch(function (e) { console.warn("[spark-agent] status erro:", e && e.message); return null; });
  }

  // ---------- UI: pill liga/desliga ----------
  function acInjectStyles() {
    if (document.getElementById("spark-agent-styles")) return;
    var css = \`
      /* GU-7: ícone-robô compacto colorido (verde=on / vermelho=off / cinza=sem agente). */
      #spark-agent-pill {
        display: inline-flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; border-radius: 10px;
        background: #ffffff; color: #94a3b8;
        border: 1px solid rgba(15,23,42,0.10);
        box-shadow: 0 2px 8px rgba(15,23,42,0.10);
        cursor: pointer; user-select: none; position: relative;
        transition: transform .15s ease, box-shadow .15s ease, opacity .2s ease, color .2s ease, border-color .2s ease, background .2s ease;
      }
      /* GU-5: inline na toolbar do topo (perto do "Call"). */
      #spark-agent-pill.sap-inline { margin: 0 10px; flex-shrink: 0; }
      /* Fallback: flutuante no canto, se a toolbar não for achada. */
      #spark-agent-pill.sap-floating { position: fixed; left: 20px; bottom: 20px; z-index: 999997; box-shadow: 0 4px 18px rgba(15,23,42,0.14); }
      #spark-agent-pill:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(15,23,42,0.16); }
      #spark-agent-pill .sap-ico { display: inline-flex; width: 20px; height: 20px; }
      #spark-agent-pill.sap-on   { color: #16a34a; border-color: rgba(22,163,74,0.35); background: rgba(22,163,74,0.08); }
      #spark-agent-pill.sap-off  { color: #ef4444; border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.07); }
      #spark-agent-pill.sap-idle { color: #94a3b8; }
      /* badge de status no canto inferior-direito do ícone */
      #spark-agent-pill::after {
        content: ""; position: absolute; right: -3px; bottom: -3px;
        width: 10px; height: 10px; border-radius: 50%;
        border: 2px solid #ffffff; background: currentColor;
      }
      #spark-agent-pill.sap-busy { opacity: .55; pointer-events: none; }
      #spark-agent-pill.sap-hidden { display: none !important; }
      /* GU-7: popup seletor único de agente */
      #spark-agent-pop {
        position: fixed; z-index: 999998; min-width: 250px; max-width: 320px;
        background: #ffffff; border: 1px solid rgba(15,23,42,0.10); border-radius: 14px;
        box-shadow: 0 14px 44px rgba(15,23,42,0.20);
        font-family: 'Open Sans', system-ui, -apple-system, sans-serif; padding: 8px;
      }
      #spark-agent-pop.sap-hidden { display: none !important; }
      #spark-agent-pop .sap-pop-head { font-size: 12px; font-weight: 700; color: #0f172a; padding: 6px 8px 9px; }
      #spark-agent-pop .sap-pop-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
      #spark-agent-pop .sap-pop-item { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; border-radius: 9px; padding: 9px 10px; cursor: pointer; font-family: inherit; text-align: left; color: #0f172a; }
      #spark-agent-pop .sap-pop-item:hover { background: rgba(22,117,242,0.08); }
      #spark-agent-pop .sap-pop-item.sap-active { background: rgba(22,163,74,0.10); }
      #spark-agent-pop .sap-pop-ico { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; background: rgba(15,23,42,0.05); color: #1675F2; flex-shrink: 0; }
      #spark-agent-pop .sap-pop-ico svg { width: 16px; height: 16px; }
      #spark-agent-pop .sap-pop-item.sap-active .sap-pop-ico { background: rgba(22,163,74,0.16); color: #16a34a; }
      #spark-agent-pop .sap-pop-name { flex: 1; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #spark-agent-pop .sap-pop-chip { font-size: 10px; font-weight: 700; color: #475569; background: rgba(15,23,42,0.06); border-radius: 999px; padding: 2px 7px; flex-shrink: 0; }
      #spark-agent-pop .sap-pop-check { width: 14px; color: #16a34a; font-weight: 800; opacity: 0; flex-shrink: 0; text-align: center; }
      #spark-agent-pop .sap-pop-item.sap-active .sap-pop-check { opacity: 1; }
      #spark-agent-pop .sap-pop-off { border-top: 1px solid rgba(15,23,42,0.07); margin-top: 4px; padding-top: 11px; color: #64748b; }
      #spark-agent-pop .sap-pop-off .sap-pop-ico { background: rgba(239,68,68,0.10); color: #ef4444; }
      #spark-agent-pop.sap-busy { opacity: .6; pointer-events: none; }
      /* GU-3: feedback 👍/👎 por mensagem do agente */
      .sap-fb { display: flex; align-items: center; justify-content: flex-start; gap: 6px; margin: 3px 0 2px 0; flex-wrap: wrap; font-family: 'Open Sans', system-ui, -apple-system, sans-serif; }
      .sap-fb-suggest { max-width: 420px; }
      .sap-fb-btn { border: 1px solid rgba(15,23,42,0.12); background: #fff; border-radius: 8px; padding: 1px 7px; font-size: 13px; line-height: 1.5; cursor: pointer; }
      .sap-fb-btn:hover { background: rgba(22,117,242,0.08); border-color: #1675F2; }
      .sap-fb-status { font-size: 11px; color: #16a34a; font-weight: 600; }
      .sap-fb-suggest { width: 100%; margin-top: 4px; }
      .sap-fb-ta { width: 100%; box-sizing: border-box; border: 1px solid rgba(15,23,42,0.15); border-radius: 8px; padding: 6px 8px; font-size: 12px; font-family: inherit; resize: vertical; }
      .sap-fb-row { display: flex; gap: 6px; margin-top: 4px; }
      .sap-fb-send { background: #1675F2; color: #fff; border: 0; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 700; cursor: pointer; }
      .sap-fb-cancel { background: rgba(15,23,42,0.06); color: #475569; border: 0; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    \`;
    var style = document.createElement("style");
    style.id = "spark-agent-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // GU-7: robô tingível (currentColor) — verde/cinza/vermelho via classe de estado.
  function acRobotSvg() {
    return [
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">',
        '<rect x="5" y="6" width="14" height="12" rx="4.5" fill="currentColor"/>',
        '<circle cx="10" cy="11.5" r="1.4" fill="#ffffff" fill-opacity="0.92"/>',
        '<circle cx="14" cy="11.5" r="1.4" fill="#ffffff" fill-opacity="0.92"/>',
        '<line x1="12" y1="3" x2="12" y2="6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        '<circle cx="12" cy="2.5" r="1.2" fill="currentColor"/>',
      '</svg>'
    ].join("");
  }

  function acEnsurePill() {
    if (!document.body) return;
    if (document.getElementById("spark-agent-pill")) return;
    acInjectStyles();
    var pill = document.createElement("div");
    pill.id = "spark-agent-pill";
    pill.className = "sap-idle";
    pill.setAttribute("role", "button");
    pill.setAttribute("aria-label", "Agente de IA deste contato");
    pill.innerHTML = '<span class="sap-ico">' + acRobotSvg() + '</span>';
    pill.addEventListener("click", function (e) { e.stopPropagation(); acTogglePopup(); });
    acPlacePill(pill);
  }

  // ---------- GU-7: popup seletor único de agente ----------
  function acEsc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function acPowerSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px"><path d="M12 3v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6.5 7a8 8 0 1 0 11 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  function acAgentLabelFor(a) {
    var t = (a && a.type) || "", n = (a && a.name) || "";
    if (t === "sales_agent") return n || "Agente de Vendas";
    if (t === "recruitment_agent") return n || "Recrutamento";
    return n || "Agente IA";
  }
  function acAgentChip(a) {
    var t = (a && a.type) || "";
    if (t === "sales_agent") return "Vendas";
    if (t === "recruitment_agent") return "Recrut.";
    return "Custom";
  }
  function acActiveAgent() {
    for (var i = 0; i < AC.agents.length; i++) { if (AC.agents[i].id === AC.activeAgentId) return AC.agents[i]; }
    return null;
  }
  function acPillTitle() {
    if (AC.iconState === "on") { var a = acActiveAgent(); return (a ? acAgentLabelFor(a) : "Agente") + " atendendo este contato — clique pra trocar"; }
    if (AC.iconState === "off") return "Agente desligado neste contato — clique pra ligar";
    return "Nenhum agente atende este contato — clique pra escolher";
  }
  function acRecomputeIconState() {
    if (AC.activeAgentId) { AC.iconState = "on"; return; }
    var anyPaused = false;
    for (var i = 0; i < AC.agents.length; i++) { if (AC.agents[i].state === "paused") { anyPaused = true; break; } }
    AC.iconState = anyPaused ? "off" : "idle";
  }
  function acEnsurePopup() {
    var ex = document.getElementById("spark-agent-pop");
    if (ex) return ex;
    var pop = document.createElement("div");
    pop.id = "spark-agent-pop";
    pop.className = "sap-pop sap-hidden";
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    document.body.appendChild(pop);
    return pop;
  }
  function acRenderPopup() {
    var pop = acEnsurePopup();
    var rows = ['<div class="sap-pop-head">Quem atende este contato?</div>', '<div class="sap-pop-list">'];
    for (var i = 0; i < AC.agents.length; i++) {
      var a = AC.agents[i];
      var on = a.id === AC.activeAgentId;
      rows.push(
        '<button class="sap-pop-item' + (on ? ' sap-active' : '') + '" data-agent="' + acEsc(a.id) + '">' +
          '<span class="sap-pop-ico">' + acRobotSvg() + '</span>' +
          '<span class="sap-pop-name">' + acEsc(acAgentLabelFor(a)) + '</span>' +
          '<span class="sap-pop-chip">' + acEsc(acAgentChip(a)) + '</span>' +
          '<span class="sap-pop-check">' + "\\u2713" + '</span>' +
        '</button>'
      );
    }
    var offOn = !AC.activeAgentId;
    rows.push(
      '<button class="sap-pop-item sap-pop-off' + (offOn ? ' sap-active' : '') + '" data-agent="">' +
        '<span class="sap-pop-ico">' + acPowerSvg() + '</span>' +
        '<span class="sap-pop-name">Desligar (ninguém atende)</span>' +
        '<span class="sap-pop-check">' + "\\u2713" + '</span>' +
      '</button>'
    );
    rows.push('</div>');
    pop.innerHTML = rows.join("");
    var items = pop.querySelectorAll(".sap-pop-item");
    for (var k = 0; k < items.length; k++) {
      items[k].addEventListener("click", function (e) {
        e.stopPropagation();
        acActivateAgent(this.getAttribute("data-agent") || null);
      });
    }
  }
  function acPositionPopup() {
    var pill = document.getElementById("spark-agent-pill");
    var pop = document.getElementById("spark-agent-pop");
    if (!pill || !pop) return;
    var r = pill.getBoundingClientRect();
    pop.style.visibility = "hidden"; pop.classList.remove("sap-hidden");
    var pw = pop.offsetWidth || 256, ph = pop.offsetHeight || 200;
    var left = Math.min(r.left, window.innerWidth - pw - 12);
    if (left < 12) left = 12;
    var top = r.bottom + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 8);
    pop.style.left = left + "px"; pop.style.top = top + "px"; pop.style.visibility = "";
  }
  function acTogglePopup() {
    var pop = document.getElementById("spark-agent-pop");
    if (pop && !pop.classList.contains("sap-hidden")) { acClosePopup(); return; }
    if (!AC.hasAgent) return;
    acRenderPopup();
    acPositionPopup();
    var p = document.getElementById("spark-agent-pop");
    if (p) p.classList.remove("sap-hidden");
    setTimeout(function () { document.addEventListener("click", acOutsideClose, true); }, 0);
  }
  function acClosePopup() {
    var pop = document.getElementById("spark-agent-pop");
    if (pop) pop.classList.add("sap-hidden");
    document.removeEventListener("click", acOutsideClose, true);
  }
  function acOutsideClose(e) {
    var pop = document.getElementById("spark-agent-pop");
    var pill = document.getElementById("spark-agent-pill");
    if (!pop) return;
    if ((pop && pop.contains(e.target)) || (pill && pill.contains(e.target))) return;
    acClosePopup();
  }
  function acActivateAgent(agentId) {
    if (!AC.token || !AC.contactId) return;
    var pop = document.getElementById("spark-agent-pop");
    if (pop) pop.classList.add("sap-busy");
    fetch(APP_URL + "/api/agents/contact-activate", {
      method: "POST",
      headers: { Authorization: "Bearer " + AC.token, "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: AC.contactId, agentId: agentId || null }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 401) { AC.token = null; }
        else if (res.j && res.j.ok) {
          AC.activeAgentId = res.j.activeAgentId || null;
          for (var i = 0; i < AC.agents.length; i++) {
            AC.agents[i].state = AC.agents[i].id === AC.activeAgentId ? "driving" : (AC.agents[i].state === "idle" ? "idle" : "paused");
          }
          acRecomputeIconState();
          console.log("[spark-agent] ativado=" + (AC.activeAgentId || "(nenhum)") + " p/ contato " + AC.contactId);
        } else { console.warn("[spark-agent] activate falhou:", res.j && res.j.reason); }
        if (pop) pop.classList.remove("sap-busy");
        acClosePopup(); acRenderPill();
        if (AC.contactId) acRefreshAiTexts(AC.contactId);
      })
      .catch(function (e) { console.warn("[spark-agent] activate erro:", e && e.message); if (pop) pop.classList.remove("sap-busy"); acClosePopup(); });
  }
  function acFetchAgents(cid) {
    if (!AC.token) return Promise.resolve(null);
    return fetch(APP_URL + "/api/agents/contact-agents?contactId=" + encodeURIComponent(cid), {
      headers: { Authorization: "Bearer " + AC.token },
    })
      .then(function (r) { if (r.status === 401) { AC.token = null; return null; } return r.json(); })
      .catch(function (e) { console.warn("[spark-agent] agents erro:", e && e.message); return null; });
  }

  // GU-5: âncora resiliente — acha o botão "Call"/"Ligar" da toolbar do contato
  // por TEXTO (o DOM do GHL é ofuscado, sem id/classe estável) e sobe até o pai
  // flex 'justify-between' (a linha do header: nome à esquerda, ações à direita).
  // Insere o pill como filho do meio → cai no espaço entre o nome e o Call.
  function acFindToolbarAnchor() {
    try {
      var btns = document.querySelectorAll("button");
      var call = null;
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "").trim();
        var r = btns[i].getBoundingClientRect();
        if ((t === "Call" || t === "Ligar") && r.width > 0 && r.top < 220) { call = btns[i]; break; }
      }
      if (!call) return null;
      var el = call;
      for (var j = 0; j < 8 && el && el.parentElement; j++) {
        var pcs = window.getComputedStyle(el.parentElement);
        if (pcs.display === "flex" && pcs.justifyContent === "space-between") {
          return { toolbar: el.parentElement, actionsGroup: el };
        }
        el = el.parentElement;
      }
      return null;
    } catch (e) { return null; }
  }

  // Coloca o pill: inline na toolbar (preferido) ou flutuante (fallback se o GHL
  // mudar o markup). Idempotente — só move se ainda não está no lugar certo
  // (sem thrash quando o watcher re-chama a cada tick).
  function acPlacePill(pill) {
    var a = acFindToolbarAnchor();
    if (a && a.toolbar && a.actionsGroup) {
      pill.classList.remove("sap-floating");
      pill.classList.add("sap-inline");
      if (pill.parentElement !== a.toolbar || pill.nextElementSibling !== a.actionsGroup) {
        a.toolbar.insertBefore(pill, a.actionsGroup);
      }
      return "inline";
    }
    pill.classList.remove("sap-inline");
    pill.classList.add("sap-floating");
    if (document.body && pill.parentElement !== document.body) document.body.appendChild(pill);
    return "floating";
  }

  function acExitConfirm() { var p = document.getElementById("spark-agent-pill"); if (p) p.classList.remove("sap-confirming"); }
  function acSetBusy(b) { var p = document.getElementById("spark-agent-pill"); if (p) p.classList.toggle("sap-busy", b); }
  function acHidePill() { var p = document.getElementById("spark-agent-pill"); if (p) p.classList.add("sap-hidden"); }

  // GU-6 (3a): mostra QUAL agente (vendas/recrut/custom) pra diferenciar.
  function acAgentLabel() {
    var t = AC.agentType || "";
    var n = AC.agentName || "";
    if (t === "sales_agent") return n || "Agente de Vendas";
    if (t === "recruitment_agent") return n || "Recrutamento";
    var label = n || "Agente IA";
    return label.length > 24 ? label.slice(0, 23) + "…" : label;
  }
  function acReasonText() {
    switch (AC.reason) {
      case "human_handling": return "humano assumiu a conversa";
      case "paused_manual": return "desligado manualmente";
      case "not_targeted": return "fora do alvo (ativação)";
      case "max_messages": return "limite de mensagens atingido";
      case "paused_auto": return "pausado automaticamente";
      default: return "";
    }
  }

  function acRenderPill() {
    var pill = document.getElementById("spark-agent-pill");
    if (!pill) return;
    if (!AC.hasAgent || !AC.contactId) { pill.classList.add("sap-hidden"); acClosePopup(); return; }
    pill.classList.remove("sap-hidden");
    pill.classList.remove("sap-on"); pill.classList.remove("sap-off"); pill.classList.remove("sap-idle");
    pill.classList.add("sap-" + (AC.iconState || "idle"));
    pill.title = acPillTitle();
    var pop = document.getElementById("spark-agent-pop");
    if (pop && !pop.classList.contains("sap-hidden")) acRenderPopup();
  }

  function acToggle(targetPaused) {
    if (!AC.token || !AC.contactId) return;
    acSetBusy(true);
    fetch(APP_URL + "/api/agents/contact-pause", {
      method: "POST",
      headers: { Authorization: "Bearer " + AC.token, "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: AC.contactId, paused: targetPaused, agentId: AC.agentId }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 401) { AC.token = null; }
        else if (res.j && res.j.ok) {
          AC.paused = targetPaused;
          console.log("[spark-agent] pause=" + targetPaused + " ok p/ contato " + AC.contactId);
        } else {
          console.warn("[spark-agent] toggle falhou:", res.j && res.j.reason);
        }
        acSetBusy(false); acExitConfirm(); acRenderPill();
      })
      .catch(function (e) { console.warn("[spark-agent] toggle erro:", e && e.message); acSetBusy(false); acExitConfirm(); acRenderPill(); });
  }

  // ---------- Loop ----------
  function acTick() {
    try {
      if (window.__SPARK_AGENT_CONTROLS_OFF) { acHidePill(); return; }
      var directCid = acContact();
      var cv = acConvId();
      if (!directCid && !cv) { acHidePill(); AC.contactId = null; AC.statusLoaded = false; return; }
      // Auth primeiro (usa loc/company/user, não o contato) — preciso do token
      // pra resolver conversationId→contactId na tela de Conversations (GU-4).
      acAuthenticate().then(function (ok) {
        if (!ok) return;
        var cid = acContact();
        if (!cid) {
          var cvNow = acConvId();
          if (!cvNow) { acHidePill(); return; }
          if (AC.resolvedForConvId !== cvNow) { acResolveConvContact(cvNow); acHidePill(); return; }
          cid = AC.resolvedContactId;
        }
        if (!cid) { acHidePill(); return; }
        if (cid === AC.contactId && AC.statusLoaded) return;
        AC.contactId = cid; AC.statusLoaded = false;
        acFetchAgents(cid).then(function (st) {
          if (acCurrentContact() !== cid) return;
          AC.statusLoaded = true;
          if (st && st.ok && st.hasAnyAgent) {
            AC.hasAgent = true;
            AC.agents = st.agents || [];
            AC.activeAgentId = st.activeAgentId || null;
            acRecomputeIconState();
            acEnsurePill(); acRenderPill();
            acRefreshAiTexts(cid); // GU-3: puxa textos da IA → marca bolhas do agente
          } else {
            AC.hasAgent = false; AC.agents = []; AC.activeAgentId = null; acHidePill(); acClosePopup();
          }
        });
      });
    } catch (e) { console.warn("[spark-agent] tick erro:", e && e.message); }
  }

  // Debug hook pro Pedro: > __sparkAgentDebug()
  window.__sparkAgentDebug = function () {
    return {
      token: !!AC.token, authedLocation: AC.authedLocation,
      contactId: AC.contactId, hasAgent: AC.hasAgent,
      agents: AC.agents ? AC.agents.length : 0, activeAgentId: AC.activeAgentId, iconState: AC.iconState,
      pill: !!document.getElementById("spark-agent-pill"),
      kill_switch: !!window.__SPARK_AGENT_CONTROLS_OFF,
      ai_texts: AC.aiTexts ? AC.aiTexts.length : 0,
      feedback_bars: document.querySelectorAll(".sap-fb").length,
      detected: { loc: acLoc(), contact: acContact(), conv: acConvId(), resolved: AC.resolvedContactId, company: acCompany(), user: acUser(), hasIdToken: !!acIdToken() },
    };
  };

  // ---------- GU-3: feedback 👍/👎 por mensagem do agente ----------
  // Normaliza pra anti-eco (igual ao server): minúsculas, sem acento, só a-z0-9.
  function acNormText(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  }

  // Busca os textos que a IA mandou pro contato (execution_log) → AC.aiTexts.
  function acRefreshAiTexts(cid) {
    if (!AC.token || !cid) return;
    fetch(APP_URL + "/api/agents/contact-ai-messages?contactId=" + encodeURIComponent(cid), {
      headers: { Authorization: "Bearer " + AC.token },
    })
      .then(function (r) { if (r.status === 401) { AC.token = null; return null; } return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.texts)) return;
        AC.aiTexts = d.texts
          .map(function (t) { return { raw: t, norm: acNormText(t) }; })
          .filter(function (x) { return x.norm.length >= 20; }); // 1c: msgs curtas dão falso-positivo
        AC.aiContactId = cid;
        acScanBubbles();
      })
      .catch(function (e) { console.warn("[spark-agent] ai-messages erro:", e && e.message); });
  }

  // Varre as bolhas: outbound (inner margin-left>1) que casa com texto da IA
  // (anti-eco) → anexa 👍/👎. Idempotente (marca data-spark-fb). Barato.
  function acScanBubbles() {
    try {
      if (window.__SPARK_AGENT_CONTROLS_OFF) return;
      if (!AC.hasAgent || !AC.aiTexts || !AC.aiTexts.length) return;
      if (AC.aiContactId !== acCurrentContact()) return;
      var items = document.querySelectorAll(".message-item");
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.getAttribute("data-spark-fb")) continue;
        var inner = it.querySelector('div[class*="message-c"]');
        if (!inner) continue;
        var ml = parseFloat(window.getComputedStyle(inner).marginLeft) || 0;
        if (ml <= 1) { it.setAttribute("data-spark-fb", "in"); continue; } // inbound (lead) — nunca tem feedback
        var bnorm = acNormText(it.textContent || "");
        if (bnorm.length < 20) continue;
        var match = null;
        for (var k = 0; k < AC.aiTexts.length; k++) {
          var an = AC.aiTexts[k].norm;
          // 1c: anti falso-positivo — a bolha CONTÉM o texto da IA E esse texto é
          // ≥60% do conteúdo da bolha (= a bolha É a msg da IA, não só contém um
          // trecho coincidente). Bolha real = msg da IA + timestamp → ratio ~0.9.
          if (an && bnorm.indexOf(an) !== -1 && an.length >= bnorm.length * 0.6) { match = AC.aiTexts[k]; break; }
        }
        // Só marca DEFINITIVO quando casa (agente). Outbound não-casado fica sem
        // marca pra re-checar quando aiTexts atualizar (msg do agente nova).
        if (match) { it.setAttribute("data-spark-fb", "1"); acAttachFeedback(it, inner, match.raw); }
      }
    } catch (e) { console.warn("[spark-agent] scan erro:", e && e.message); }
  }

  function acAttachFeedback(item, inner, aiText) {
    if (item.querySelector(".sap-fb")) return;
    var bar = document.createElement("div");
    bar.className = "sap-fb";
    bar.innerHTML = [
      '<button class="sap-fb-btn sap-fb-up" type="button" title="Boa resposta">👍</button>',
      '<button class="sap-fb-btn sap-fb-down" type="button" title="Podia ser melhor">👎</button>',
      '<span class="sap-fb-status"></span>',
    ].join("");
    bar.querySelector(".sap-fb-up").addEventListener("click", function (e) { e.stopPropagation(); acSendFeedback(aiText, "positive", null, bar); });
    bar.querySelector(".sap-fb-down").addEventListener("click", function (e) { e.stopPropagation(); acOpenSuggest(bar, aiText); });
    // 1a (ajuste Pedro 2026-06-04): 👍/👎 logo ABAIXO da BOLHA, alinhados à
    // esquerda DELA — anexa na coluna que envolve a bolha (o pai do elemento
    // flex-col w-fit), não na linha inteira (que jogava pro canto esquerdo da
    // tela). 1b: a sugestão do 👎 flui pra baixo. Fallback: inner / item.
    var bubble = item.querySelector('div[class*="flex-col"][class*="w-fit"]');
    var target = (bubble && bubble.parentElement) || inner || item;
    try { target.appendChild(bar); } catch (e) { item.appendChild(bar); }
  }

  function acOpenSuggest(bar, aiText) {
    if (bar.querySelector(".sap-fb-suggest")) return;
    var box = document.createElement("div");
    box.className = "sap-fb-suggest";
    box.innerHTML = [
      '<textarea class="sap-fb-ta" rows="2" placeholder="Como você preferia essa resposta?"></textarea>',
      '<div class="sap-fb-row"><button class="sap-fb-send" type="button">Enviar feedback</button><button class="sap-fb-cancel" type="button">Cancelar</button></div>',
    ].join("");
    bar.appendChild(box);
    var ta = box.querySelector(".sap-fb-ta");
    try { ta.focus(); } catch (e) {}
    box.querySelector(".sap-fb-send").addEventListener("click", function (e) { e.stopPropagation(); acSendFeedback(aiText, "negative", ta.value, bar); });
    box.querySelector(".sap-fb-cancel").addEventListener("click", function (e) { e.stopPropagation(); box.remove(); });
  }

  function acSendFeedback(aiText, rating, suggestion, bar) {
    if (!AC.token || !AC.agentId || !AC.contactId) return;
    var status = bar.querySelector(".sap-fb-status");
    if (status) status.textContent = "enviando...";
    fetch(APP_URL + "/api/agents/message-feedback", {
      method: "POST",
      headers: { Authorization: "Bearer " + AC.token, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AC.agentId, contactId: AC.contactId, aiMessage: aiText, rating: rating, suggestion: suggestion || undefined }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          bar.innerHTML = '<span class="sap-fb-status">' + (rating === "positive" ? "👍 Valeu! Anotado." : "👎 Anotado - vou ajustar.") + "</span>";
          console.log("[spark-agent] feedback " + rating + " enviado");
        } else if (status) { status.textContent = "falhou, tenta de novo"; }
      })
      .catch(function () { if (status) status.textContent = "erro de rede"; });
  }

  function acBoot() {
    acTick();
    setInterval(acTick, TICK_MS);
    // Vue re-render pode MATAR o pill (remove da toolbar) OU re-renderizar a
    // toolbar deixando o pill órfão/flutuante. A cada tick, se ativo: re-cria
    // se sumiu, senão RE-POSICIONA (acPlacePill é idempotente — só move se
    // saiu do lugar; e promove flutuante→inline quando a toolbar aparece).
    setInterval(function () {
      try {
        if (!(AC.hasAgent && AC.contactId && acCurrentContact() === AC.contactId)) return;
        var pill = document.getElementById("spark-agent-pill");
        if (!pill) { acEnsurePill(); acRenderPill(); return; }
        acPlacePill(pill);
        acScanBubbles(); // GU-3: re-anexa 👍/👎 após re-render / msgs novas
      } catch (e) {}
    }, REINJECT_MS);
    // GU-3: refresca os textos da IA periodicamente (msg do agente nova entra no
    // anti-eco) — 25s. Só quando ativo no mesmo contato.
    setInterval(function () {
      try {
        if (AC.hasAgent && AC.contactId && acCurrentContact() === AC.contactId) acRefreshAiTexts(AC.contactId);
      } catch (e) {}
    }, 25000);
    console.log("[spark-agent] módulo de controles iniciado");
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    acBoot();
  } else {
    window.addEventListener("DOMContentLoaded", acBoot);
  }
})();`;
