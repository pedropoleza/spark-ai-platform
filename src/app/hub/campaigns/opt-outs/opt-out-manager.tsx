"use client";

/**
 * Client manager pra Opt-outs (Etapa 4.8).
 *
 * Sections:
 *   - Keywords ativas (default + custom editável)
 *   - Listing de opt-outs com botão "Remover" pra desfazer.
 *   - Adicionar opt-out manual por contact_id.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Plus, X } from "lucide-react";

interface OptOutRow {
  id: string;
  contact_id: string;
  source: string;
  reason: string | null;
  created_at: string;
}

interface Props {
  initialOptouts: OptOutRow[];
  defaultKeywords: string[];
  initialCustomKeywords: string[];
}

const SOURCE_LABEL: Record<string, string> = {
  keyword: "Auto (respondeu)",
  manual: "Manual (admin)",
  webhook: "Webhook",
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function OptOutManager({ initialOptouts, defaultKeywords, initialCustomKeywords }: Props) {
  const router = useRouter();
  const [optouts, setOptouts] = useState<OptOutRow[]>(initialOptouts);
  const [customKeywords, setCustomKeywords] = useState<string[]>(initialCustomKeywords);
  const [newKw, setNewKw] = useState("");
  const [savingKws, setSavingKws] = useState(false);
  const [newContactId, setNewContactId] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  async function saveCustomKeywords(next: string[]) {
    setSavingKws(true);
    try {
      const res = await fetch("/api/hub/campaigns/opt-out-keywords", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_keywords: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; custom?: string[]; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      setCustomKeywords(json.custom || next);
      toast.success("Keywords atualizadas");
    } catch (err) {
      toast.error("Não consegui salvar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setSavingKws(false);
    }
  }

  async function addKeyword() {
    const trimmed = newKw.trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > 60) return;
    if (customKeywords.includes(trimmed) || defaultKeywords.includes(trimmed)) {
      toast.info("Keyword já está na lista");
      setNewKw("");
      return;
    }
    const next = [...customKeywords, trimmed];
    setNewKw("");
    await saveCustomKeywords(next);
  }

  async function removeKeyword(kw: string) {
    const next = customKeywords.filter((k) => k !== kw);
    await saveCustomKeywords(next);
  }

  async function removeOptout(contactId: string) {
    if (!window.confirm(`Remover opt-out do contato ${contactId.slice(0, 12)}…? Ele vai voltar a receber campanhas.`)) return;
    try {
      const res = await fetch("/api/hub/campaigns/opt-outs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      setOptouts((prev) => prev.filter((r) => r.contact_id !== contactId));
      toast.success("Opt-out removido");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui: " + (err instanceof Error ? err.message : ""));
    }
  }

  async function addManualOptout() {
    const trimmed = newContactId.trim();
    if (trimmed.length === 0) return;
    setAddingContact(true);
    try {
      const res = await fetch("/api/hub/campaigns/opt-outs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; already_opted_out?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      if (json.already_opted_out) {
        toast.info("Esse contato já estava opt-out");
      } else {
        toast.success("Contato marcado como opt-out");
      }
      setNewContactId("");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui: " + (err instanceof Error ? err.message : ""));
    } finally {
      setAddingContact(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      {/* Keywords ativas */}
      <div className="card">
        <div className="card-hd">
          <h3>Keywords ativas</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Contato respondendo com qualquer uma vira opt-out
          </span>
        </div>
        <div className="card-body" style={{ padding: 16 }}>
          <div style={{ marginBottom: 14 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Globais (PT+EN, não editáveis):
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {defaultKeywords.map((k) => (
                <span key={k} className="pill pill--muted" style={{ fontSize: 11.5 }}>
                  {k}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Customizadas desta location:
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {customKeywords.length === 0 && (
                <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
                  Nenhuma — adicione abaixo.
                </span>
              )}
              {customKeywords.map((k) => (
                <span
                  key={k}
                  className="pill"
                  style={{ fontSize: 11.5, paddingRight: 4, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  {k}
                  <button
                    type="button"
                    onClick={() => removeKeyword(k)}
                    aria-label={`Remover ${k}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "0 2px",
                      color: "inherit",
                    }}
                    disabled={savingKws}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                className="input"
                value={newKw}
                onChange={(e) => setNewKw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="ex: chega, off, remova"
                maxLength={60}
                style={{ maxWidth: 240 }}
                disabled={savingKws}
              />
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={addKeyword}
                disabled={savingKws || newKw.trim().length === 0}
              >
                <Plus size={14} /> Adicionar
              </button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Palavras inteiras, case-insensitive. Mensagens longas ({">"}200 chars) não são consideradas opt-out.
            </div>
          </div>
        </div>
      </div>

      {/* Adicionar opt-out manual */}
      <div className="card">
        <div className="card-hd">
          <h3>Marcar opt-out manual</h3>
        </div>
        <div className="card-body" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              className="input"
              value={newContactId}
              onChange={(e) => setNewContactId(e.target.value)}
              placeholder="contact_id do Spark Leads"
              style={{ flex: 1, maxWidth: 400 }}
              disabled={addingContact}
            />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={addManualOptout}
              disabled={addingContact || newContactId.trim().length === 0}
            >
              {addingContact ? "Marcando…" : "Marcar"}
            </button>
          </div>
        </div>
      </div>

      {/* Listing */}
      <div className="card">
        <div className="card-hd">
          <h3>Contatos opt-out</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {optouts.length} total (até 500 mais recentes)
          </span>
        </div>
        {optouts.length === 0 ? (
          <div className="empty" style={{ padding: 40, textAlign: "center" }}>
            <div className="muted" style={{ fontSize: 13 }}>
              Nenhum opt-out registrado. Quando algum contato responder STOP ou PARAR, aparece aqui.
            </div>
          </div>
        ) : (
          <div>
            {optouts.map((r) => (
              <div
                key={r.id}
                className="lrow"
                style={{ gridTemplateColumns: "1fr auto", padding: "12px 16px", alignItems: "center" }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 3, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontFamily: "monospace" }}>{r.contact_id}</span>
                    <span className="pill pill--muted" style={{ fontSize: 11 }}>
                      {SOURCE_LABEL[r.source] || r.source}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {r.reason || "sem motivo"} · {fmtDate(r.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => removeOptout(r.contact_id)}
                  style={{ color: "#991B1B" }}
                  aria-label={`Remover opt-out de ${r.contact_id}`}
                >
                  <Trash2 size={14} /> Remover
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
