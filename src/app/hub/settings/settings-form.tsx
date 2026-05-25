"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fstack">
      <div className="fstack__lbl">{label}</div>
      {hint && <div className="fstack__hint">{hint}</div>}
      <div>{children}</div>
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
            <input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" style={{ maxWidth: 320 }} />
          </Field>
          <Field label="Idioma">
            <span className="pill pill--info">PT-BR</span>
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-hd"><h3>Limites</h3></div>
        <div className="card-body">
          <Field label="Limite de mensagens por dia" hint="Deixe vazio para sem limite.">
            <input className="input" type="number" min={0} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} style={{ width: 140 }} />
          </Field>
          <Field label="Alerta de custo (USD)" hint="Avisa quando o gasto do mês passar desse valor.">
            <input className="input" type="number" min={0} value={costAlert} onChange={(e) => setCostAlert(e.target.value)} style={{ width: 140 }} />
          </Field>
        </div>
      </div>
    </div>
  );
}
