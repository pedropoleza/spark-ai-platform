"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";

// Lista de fusos IANA pro autocomplete do timezone (Pedro 2026-05-28). Intl.
// supportedValuesOf chega no Chrome 99+/FF 93+/Safari 15.4+/Node 18+ — em 2026
// universal. Fallback hardcoded cobre os tz mais comuns só por garantia.
const TIMEZONE_OPTIONS: string[] = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (Intl as any).supportedValuesOf;
    if (typeof fn === "function") return fn("timeZone") as string[];
  } catch { /* cai pro fallback */ }
  return [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Sao_Paulo", "America/Bahia", "America/Manaus", "America/Recife",
    "America/Toronto", "America/Mexico_City", "America/Bogota", "America/Buenos_Aires",
    "UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
    "Asia/Tokyo", "Asia/Shanghai", "Asia/Dubai", "Australia/Sydney",
  ];
})();

// Mesmo padrão da tela de config (head reserva label+hint → alinhamento consistente).
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fstack">
      <div className="fstack__head">
        <div className="fstack__lbl">{label}</div>
        <div className="fstack__hint">{hint || " "}</div>
      </div>
      <div className="fstack__ctrl">{children}</div>
    </div>
  );
}

export function SettingsForm({
  locationName,
  initial,
}: {
  locationName: string;
  // F30 (Pedro 2026-05-28): dailyLimit/costAlert removidos — eram dead-write
  // (UI gravava, runtime nunca aplicava). Hard cap mensal por sub-account já
  // protege contra runaway de custo. Re-introduzir só se ligarmos runtime.
  initial: { timezone: string };
}) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [saving, setSaving] = useState(false);
  const dirty = timezone !== initial.timezone;

  // Pedro 2026-05-28: warn antes de sair com mudanças não-salvas. Antes user
  // alterava tz, esquecia de salvar, voltava — tz original persistia, achava
  // que tinha mudado. Browser limita a mensagem custom (mostra default do SO).
  useEffect(() => {
    if (!dirty || saving) return;
    const handler = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving]);

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { default_timezone: timezone };
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success("Conta salva");
    } catch (err) {
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Conta</h1>
          <p className="page-hd__sub">Preferências da sua agência.</p>
        </div>
        <button className="btn btn--primary" onClick={save} disabled={saving || !dirty}>
          <Check /> {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>

      <div className="card">
        <div className="card-hd"><h3>Agência</h3></div>
        <div className="card-body">
          <Field label="Nome">
            <input className="input" value={locationName} disabled style={{ opacity: 0.7 }} />
          </Field>
          <Field label="Fuso horário" hint="Usado para horário de atendimento e agendamentos.">
            {/* Pedro 2026-05-28 — antes era input livre: user digitava "Sao Paulo"
                e salvava inválido até bater no validate do backend (e o campo não
                limpava, ficava preso no valor errado). Agora datalist com lista IANA
                completa (Intl.supportedValuesOf) — UX de autocomplete, sem footgun. */}
            <input
              className="input"
              list="settings-tz-options"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
              style={{ maxWidth: 320 }}
              aria-label="Fuso horário"
            />
            <datalist id="settings-tz-options">
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </Field>
          <Field label="Idioma">
            <span className="pill pill--info">PT-BR</span>
          </Field>
        </div>
      </div>

      {/* F30 (Pedro 2026-05-28): card "Limites (em breve)" removido — 2 toggles
          eram dead-write (UI gravava daily_message_limit + cost_alert_threshold,
          runtime nunca aplicava). Proteção real contra runaway = hard cap mensal
          em agent_configs.monthly_spend_cap_usd, já enforced via charge.ts.
          Re-introduzir só se ligarmos enforcement (cron diário lê usage_records). */}
    </div>
  );
}
