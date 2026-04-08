"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, FileText, Globe, Type, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface KBItem {
  id: string;
  type: "text" | "file" | "url";
  title: string;
  content: string;
  file_name?: string;
  file_url?: string;
  token_count: number;
  created_at: string;
}

interface KnowledgeBaseEditorProps {
  agentId: string | null;
}

export function KnowledgeBaseEditor({ agentId }: KnowledgeBaseEditorProps) {
  const [items, setItems] = useState<KBItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState<"text" | "file" | "url" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [uploading, setUploading] = useState(false);

  const fetchItems = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/knowledge-base?agent_id=${agentId}`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch (e) {
      console.error("Erro ao buscar KB:", e);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const totalTokens = items.reduce((sum, item) => sum + (item.token_count || 0), 0);

  const handleAddText = async () => {
    if (!agentId || !title || !content) return;
    setUploading(true);
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, type: "text", title, content }),
      });
      if (res.ok) {
        await fetchItems();
        resetForm();
      }
    } finally {
      setUploading(false);
    }
  };

  const handleAddUrl = async () => {
    if (!agentId || !title || !content) return;
    setUploading(true);
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, type: "url", title, content }),
      });
      if (res.ok) {
        await fetchItems();
        resetForm();
      }
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !agentId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("agent_id", agentId);
      formData.append("title", title || file.name);

      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        await fetchItems();
        resetForm();
      }
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/knowledge-base?id=${id}`, { method: "DELETE" });
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const resetForm = () => {
    setAddType(null);
    setAdding(false);
    setTitle("");
    setContent("");
  };

  const iconMap = { text: Type, file: FileText, url: Globe };

  if (!agentId) {
    return <p className="text-sm text-neutral-400">Salve o agente primeiro para adicionar conhecimento.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-400">
          {items.length} item(ns) | ~{totalTokens.toLocaleString()} tokens no contexto
        </p>
        {totalTokens > 8000 && (
          <Badge variant="warning" className="text-[10px]">
            Contexto grande — pode aumentar custo
          </Badge>
        )}
      </div>

      {/* Lista de itens */}
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const Icon = iconMap[item.type] || FileText;
            return (
              <div key={item.id} className="flex items-center gap-3 p-3 bg-white border border-neutral-200 rounded-lg group">
                <Icon className="w-4 h-4 text-neutral-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-neutral-900 block truncate">{item.title}</span>
                  <span className="text-xs text-neutral-400">
                    {item.type === "file" ? item.file_name : item.type === "url" ? "URL" : "Texto"}
                    {" — ~"}{item.token_count.toLocaleString()} tokens
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Adicionar */}
      {adding ? (
        <Card>
          <CardContent className="p-4 space-y-3">
            {!addType ? (
              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => setAddType("text")}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-neutral-200 rounded-xl hover:border-neutral-400 transition-colors"
                >
                  <Type className="w-5 h-5 text-neutral-400" />
                  <span className="text-sm font-medium">Texto</span>
                  <span className="text-[10px] text-neutral-400">Cole conteudo diretamente</span>
                </button>
                <button
                  onClick={() => setAddType("file")}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-neutral-200 rounded-xl hover:border-neutral-400 transition-colors"
                >
                  <Upload className="w-5 h-5 text-neutral-400" />
                  <span className="text-sm font-medium">Arquivo</span>
                  <span className="text-[10px] text-neutral-400">PDF, TXT, DOC, CSV</span>
                </button>
                <button
                  onClick={() => setAddType("url")}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-neutral-200 rounded-xl hover:border-neutral-400 transition-colors"
                >
                  <Globe className="w-5 h-5 text-neutral-400" />
                  <span className="text-sm font-medium">URL</span>
                  <span className="text-[10px] text-neutral-400">Importar de um site</span>
                </button>
              </div>
            ) : addType === "text" ? (
              <>
                <Label className="text-xs">Titulo</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Informacoes sobre produtos" />
                <Label className="text-xs">Conteudo</Label>
                <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder="Cole aqui o texto que a IA deve usar como referencia..." />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddText} disabled={!title || !content || uploading}>
                    {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                    Adicionar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
                </div>
              </>
            ) : addType === "file" ? (
              <>
                <Label className="text-xs">Titulo (opcional)</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nome do documento" />
                <Label className="text-xs">Arquivo</Label>
                <Input type="file" accept=".pdf,.txt,.doc,.docx,.csv,.md" onChange={handleUploadFile} disabled={uploading} />
                {uploading && <p className="text-xs text-neutral-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Processando arquivo...</p>}
                <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
              </>
            ) : (
              <>
                <Label className="text-xs">Titulo</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Site da empresa" />
                <Label className="text-xs">URL</Label>
                <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="https://..." />
                <p className="text-xs text-neutral-400">O sistema vai extrair o texto do site automaticamente</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleAddUrl} disabled={!title || !content || uploading}>
                    {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                    Importar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="w-full">
          <Plus className="w-3.5 h-3.5 mr-2" />
          Adicionar conhecimento
        </Button>
      )}
    </div>
  );
}
