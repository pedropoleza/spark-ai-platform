"use client";

/**
 * Gerenciador de conhecimento POR AGENTE (aba Conhecimento do /hub).
 * Lista/edita as entries de `knowledge_base` (que o agente de lead consome no
 * prompt) via /api/knowledge-base. Suporta colar texto e subir arquivo
 * (PDF/Excel/Word/CSV/foto) — o backend extrai o texto e o agente passa a usar.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Upload, Plus, Trash2, Table, Image as ImageIcon, Link2, Type } from "lucide-react";

interface KbItem {
  id: string;
  type: "text" | "file" | "url";
  title: string;
  file_name?: string | null;
  token_count?: number;
  created_at?: string;
}

const ACCEPT = ".pdf,.xlsx,.xls,.csv,.txt,.md,.docx,.png,.jpg,.jpeg,.webp";

export function KbManager({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<KbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/knowledge-base?agent_id=${encodeURIComponent(agentId)}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? (data.items as KbItem[]) : []);
    } catch {
      /* mantém o que tem */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function addText() {
    if (!title.trim() || !content.trim()) return;
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, type: "text", title: title.trim(), content: content.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      setTitle("");
      setContent("");
      setShowAdd(false);
      toast.success("Conhecimento adicionado");
      void load();
    } catch (err) {
      toast.error("Não consegui salvar. " + (err instanceof Error ? err.message : ""));
    }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("agent_id", agentId);
      const res = await fetch("/api/knowledge-base", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success(`"${file.name}" processado`);
      void load();
    } catch (err) {
      toast.error("Falha no upload: " + (err instanceof Error ? err.message : ""));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: string) {
    setItems((p) => p.filter((x) => x.id !== id));
    try {
      await fetch(`/api/knowledge-base?id=${encodeURIComponent(id)}&agent_id=${encodeURIComponent(agentId)}`, { method: "DELETE" });
    } catch {
      void load();
    }
  }

  const icon = (it: KbItem) => {
    if (it.type === "url") return <Link2 size={15} />;
    const n = (it.file_name || "").toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(n)) return <Table size={15} />;
    if (/\.(png|jpe?g|webp|gif)$/.test(n)) return <ImageIcon size={15} />;
    if (it.type === "file") return <FileText size={15} />;
    return <Type size={15} />;
  };

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10, alignItems: "center" }}>
        <div className="eyebrow">Documentos do agente · {items.length}</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setShowAdd((s) => !s)}><Plus size={13} /> Texto</button>
          <button className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()} disabled={uploading}><Upload size={13} /> Arquivo</button>
          <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        </div>
      </div>

      {showAdd && (
        <div className="card card--flat" style={{ padding: 12, background: "var(--surface-2)", marginBottom: 10 }}>
          <input className="input" placeholder="Título (ex: Tabela de preços família)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 8 }} />
          <textarea className="textarea" rows={4} maxLength={50000} placeholder="Cole aqui o conhecimento (produtos, preços, regras, FAQ…)" value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn btn--primary btn--sm" onClick={addText} disabled={!title.trim() || !content.trim()}>Adicionar</button>
            <button className="btn btn--quiet btn--sm" onClick={() => { setShowAdd(false); setTitle(""); setContent(""); }}>Cancelar</button>
          </div>
        </div>
      )}

      {uploading && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Processando arquivo (lendo o conteúdo)… pode levar alguns segundos.</div>}

      {loading ? (
        <div className="muted" style={{ fontSize: 13 }}>Carregando…</div>
      ) : items.length === 0 ? (
        <div className="card card--flat" style={{ padding: 16, background: "var(--surface-2)", textAlign: "center" }}>
          <Upload size={18} style={{ color: "var(--ink-4)", marginBottom: 6 }} />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Nenhum documento ainda</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>Suba PDF, Excel, foto ou cole um texto — o agente passa a usar no atendimento.</div>
        </div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {items.map((it) => (
            <div key={it.id} className="row between" style={{ gap: 10, padding: "9px 12px", border: "1px solid var(--line)", borderRadius: "var(--r-md)", alignItems: "center" }}>
              <div className="row" style={{ gap: 10, minWidth: 0, alignItems: "center" }}>
                <span style={{ color: "var(--ink-4)", display: "inline-flex", flexShrink: 0 }}>{icon(it)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {it.file_name || (it.type === "text" ? "texto" : it.type)}{it.token_count ? ` · ~${it.token_count} tokens` : ""}
                  </div>
                </div>
              </div>
              <button className="btn btn--quiet btn--icon btn--sm" onClick={() => remove(it.id)} aria-label="Remover"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
