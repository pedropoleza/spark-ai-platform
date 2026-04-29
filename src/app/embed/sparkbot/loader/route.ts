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

  function detectCompanyId() {
    // GHL injeta em vários globais; tenta os mais comuns.
    try { if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.companyId) return window.__INITIAL_STATE__.companyId; } catch (e) {}
    try { if (window.app && window.app.companyId) return window.app.companyId; } catch (e) {}
    var meta = document.querySelector('meta[name="company-id"]');
    if (meta) return meta.getAttribute("content");
    return null;
  }

  function detectUserId() {
    // 1) Tenta JWT do localStorage (pattern conhecido do GHL)
    try {
      var jwt = localStorage.getItem("token-id") || localStorage.getItem("ghl_user_token");
      if (jwt) {
        var payload = JSON.parse(atob(jwt.split(".")[1]));
        if (payload.user_id) return payload.user_id;
        if (payload.userId) return payload.userId;
        if (payload.sub) return payload.sub;
      }
    } catch (e) {}
    // 2) Globals
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

  // ---------- UI: floating button + panel ----------
  function injectStyles() {
    if (document.getElementById("sparkbot-styles")) return;
    var css = \`
      #sparkbot-fab {
        position: fixed; right: 20px; bottom: 20px; z-index: 999998;
        width: 56px; height: 56px; border-radius: 50%;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; border: none; transition: transform 0.2s;
        font-family: system-ui, -apple-system, sans-serif;
      }
      #sparkbot-fab:hover { transform: scale(1.05); }
      #sparkbot-fab svg { width: 28px; height: 28px; color: white; }
      #sparkbot-fab .badge {
        position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px;
        padding: 0 6px; background: #ef4444; color: white; border-radius: 10px;
        font-size: 11px; font-weight: 700; display: flex; align-items: center;
        justify-content: center; border: 2px solid white;
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

  function injectFab() {
    if (document.getElementById("sparkbot-fab")) return;
    var btn = document.createElement("button");
    btn.id = "sparkbot-fab";
    btn.title = "Sparkbot";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.onclick = togglePanel;
    document.body.appendChild(btn);
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
    var fab = document.getElementById("sparkbot-fab");
    if (!fab) return;
    var existing = fab.querySelector(".badge");
    if (count > 0) {
      if (!existing) {
        var b = document.createElement("span");
        b.className = "badge";
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
    // Wait pra GHL terminar o initial load (URL pode ainda não ter locationId)
    var attempts = 0;
    var iv = setInterval(function () {
      attempts++;
      if (detectLocationId() && detectUserId()) {
        clearInterval(iv);
        authenticate().then(function (ok) {
          if (!ok) return;
          injectStyles();
          injectFab();
          poll();
          setInterval(poll, POLL_MS);
          setInterval(heartbeat, HEARTBEAT_MS);
        });
      }
      if (attempts > 30) clearInterval(iv); // 30s timeout — desiste se URL não evolui
    }, 1000);
  }

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
