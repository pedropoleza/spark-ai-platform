"use client";

import { useState } from "react";
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
  initial: { timezone: string; dailyLimit: number | null; costAlert: number | null };
}) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyLimit, setDailyLimit] = useState(initial.dailyLimit?.toString() ?? "");
  const [costAlert, setCostAlert] = useState(initial.costAlert?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const dirty =
    timezone !== initial.timezone ||
    dailyLimit !== (initial.dailyLimit?.toString() ?? "") ||
    costAlert !== (initial.costAlert?.toString() ?? "");

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { default_timezone: timezone };
      if (dailyLimit.trim()) body.daily_message_limit = Number(dailyLimit);
      if (costAlert.trim()) body.cost_alert_threshold = Number(costAlert);
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

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-hd"><h3>Limites (em breve)</h3></div>
        <div className="card-body">
          {/* C3-7 (ultra-review 2026-05-26): estes 2 ainda NÃO são aplicados pelo
              runtime (dead-write). Nota honesta + o hard cap mensal real (por
              sub-account) já protege contra runaway. Remover o "em breve" quando
              ligar o enforcement. */}
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 10px" }}>
            Ainda não aplicamos estes limites automaticamente — em breve. O teto mensal de gasto por sub-account já está ativo e protege contra disparada de custo.
          </p>
          <Field label="Limite de mensagens por dia" hint="Em breve — ainda não aplicado.">
            <input className="input" type="number" min={0} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} style={{ width: 140 }} />
          </Field>
          <Field label="Alerta de custo (USD)" hint="Em breve — ainda não enviamos esse alerta.">
            <input className="input" type="number" min={0} value={costAlert} onChange={(e) => setCostAlert(e.target.value)} style={{ width: 140 }} />
          </Field>
        </div>
      </div>
    </div>
  );
}
