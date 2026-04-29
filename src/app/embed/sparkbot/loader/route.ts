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
      "Cache-Control": "public, max-age=300", // 5 min
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function buildLoaderScript(): string {
  // Embedded as a single IIFE. Cada `__VAR__` é um placeholder substituído
  // server-side pra não vazar URL/intervalos nos comentários do navegador.
  const raw = LOADER_SOURCE
    .replaceAll("__APP_URL__", APP_URL)
    .replaceAll("__POLL_INTERVAL_MS__", String(POLL_INTERVAL_MS))
    .replaceAll("__HEARTBEAT_INTERVAL_MS__", String(HEARTBEAT_INTERVAL_MS));
  return raw;
}

const LOADER_SOURCE = `(function () {
  if (window.__sparkbotInjected) return;
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

    return fetch(APP_URL + "/api/sparkbot/check-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userId,
        locationId: locationId,
        companyId: companyId,
        locationName: detectLocationName(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
      /* Botão inline no header GHL — segue tamanho/forma dos outros círculos */
      .sparkbot-btn {
        position: relative;
        width: 36px; height: 36px; border-radius: 50%;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
        display: inline-flex; align-items: center; justify-content: center;
        cursor: pointer; border: none; transition: transform 0.15s, box-shadow 0.15s;
        font-family: system-ui, -apple-system, sans-serif;
        margin: 0 6px; flex-shrink: 0;
        vertical-align: middle;
      }
      .sparkbot-btn:hover { transform: scale(1.06); box-shadow: 0 3px 12px rgba(99, 102, 241, 0.45); }
      .sparkbot-btn svg { width: 18px; height: 18px; color: white; }
      .sparkbot-btn .sparkbot-badge {
        position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
        padding: 0 5px; background: #ef4444; color: white; border-radius: 9px;
        font-size: 10px; font-weight: 700; display: flex; align-items: center;
        justify-content: center; border: 2px solid white;
      }
      /* Fallback flutuante (canto inferior direito) — usado se header não for achado */
      .sparkbot-btn.sparkbot-floating {
        position: fixed; right: 20px; bottom: 20px; z-index: 999998;
        width: 56px; height: 56px; margin: 0;
      }
      .sparkbot-btn.sparkbot-floating svg { width: 28px; height: 28px; }
      .sparkbot-btn.sparkbot-floating .sparkbot-badge {
        top: -4px; right: -4px; min-width: 20px; height: 20px; font-size: 11px;
      }
      #sparkbot-panel {
        position: fixed; top: 0; right: 0; bottom: 0; width: 450px;
        max-width: 100vw; z-index: 999999;
        background: white; box-shadow: -4px 0 16px rgba(0, 0, 0, 0.1);
        transform: translateX(100%); transition: transform 0.3s ease;
        display: flex; flex-direction: column;
        font-family: system-ui, -apple-system, sans-serif;
      }
      #sparkbot-panel.open { transform: translateX(0); }
      #sparkbot-panel-header {
        padding: 16px; border-bottom: 1px solid #e5e7eb;
        display: flex; justify-content: space-between; align-items: center;
        background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
      }
      #sparkbot-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
      #sparkbot-panel-close {
        background: rgba(255,255,255,0.2); border: 0; color: white; cursor: pointer;
        width: 28px; height: 28px; border-radius: 50%; font-size: 18px; line-height: 1;
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
    btn.title = "Sparkbot — copiloto IA";
    btn.setAttribute("aria-label", "Abrir Sparkbot");
    // Ícone de chat/sparkles (combina com a estética do GHL e diferencia do "Ask AI")
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 14l.7 2.1L21.8 17l-2.1.7L19 19.8l-.7-2.1L16.2 17l2.1-.7L19 14z"/></svg>';
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

    var header = document.createElement("div");
    header.id = "sparkbot-panel-header";
    var title = document.createElement("h3");
    title.textContent = "Sparkbot";
    var close = document.createElement("button");
    close.id = "sparkbot-panel-close";
    close.innerHTML = "&times;";
    close.onclick = togglePanel;
    header.appendChild(title);
    header.appendChild(close);

    var iframe = document.createElement("iframe");
    iframe.id = "sparkbot-iframe";
    iframe.src = APP_URL + "/embed/sparkbot?token=" + encodeURIComponent(STATE.token) +
                 "&repName=" + encodeURIComponent(STATE.repName);
    iframe.allow = "microphone; clipboard-write; notifications";

    panel.appendChild(header);
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
