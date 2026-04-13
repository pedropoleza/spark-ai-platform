"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, FileText, Globe, Type, Upload, Loader2, Pencil, ChevronDown, ChevronUp } from "lucide-react";
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
  description?: string | null;
  usage_instructions?: string | null;
  token_count: number;
  created_at: string;
}

interface KnowledgeBaseEditorProps {
  agentId: string | null;
}

const INSTRUCTION_PLACEHOLDER =
  "Ex: Use este documento como fonte oficial para responder sobre precos e politicas de entrega. Se o lead perguntar prazos, cite exatamente os valores da tabela. Nunca mencione o nome do arquivo.";

const DESCRIPTION_PLACEHOLDER =
  "Ex: Tabela de precos e prazos de entrega (2026). Contem SKUs, valores e regioes atendidas.";

export function KnowledgeBaseEditor({ agentId }: KnowledgeBaseEditorProps) {
  const [items, setItems] = useState<KBItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState<"text" | "file" | "url" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  const [usageInstructions, setUsageInstructions] = useState("");
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editUsage, setEditUsage] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

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

  const resetForm = () => {
    setAddType(null);
    setAdding(false);
    setTitle("");
    setContent("");
    setDescription("");
    setUsageInstructions("");
  };

  const handleAddText = async () => {
    if (!agentId || !title || !content) return;
    setUploading(true);
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          type: "text",
          title,
          content,
          description,
          usage_instructions: usageInstructions,
        }),
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
        body: JSON.stringify({
          agent_id: agentId,
          type: "url",
          title,
          content,
          description,
          usage_instructions: usageInstructions,
        }),
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
      formData.append("description", description);
      formData.append("usage_instructions", usageInstructions);

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

  const startEdit = (item: KBItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description || "");
    setEditUsage(item.usage_instructions || "");
    setExpandedId(item.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
    setEditDescription("");
    setEditUsage("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSavingEdit(true);
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          title: editTitle,
          description: editDescription,
          usage_instructions: editUsage,
        }),
      });
      if (res.ok) {
        await fetchItems();
        cancelEdit();
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const iconMap = { text: Type, file: FileText, url: Globe };

  if (!agentId) {
    return <p className="text-sm text-neutral-500">Salve o agente primeiro para adicionar conhecimento.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          <span className="text-neutral-300 font-medium">{items.length}</span> item(ns) · ~<span className="text-neutral-300 font-medium">{totalTokens.toLocaleString()}</span> tokens no contexto
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
            const isExpanded = expandedId === item.id;
            const isEditing = editingId === item.id;
            const hasMeta = !!(item.description || item.usage_instructions);
            return (
              <div key={item.id} className="rounded-xl border border-white/8 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 transition-all duration-200 group overflow-hidden">
                <div className="flex items-center gap-3 p-3">
                  <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4 text-violet-300" />
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="text-sm font-medium text-neutral-100 block truncate">{item.title}</span>
                    <span className="text-xs text-neutral-500">
                      {item.type === "file" ? item.file_name : item.type === "url" ? "URL" : "Texto"}
                      {" · ~"}{item.token_count.toLocaleString()} tokens
                      {hasMeta && <span className="ml-1 text-violet-400">· com instrucoes</span>}
                    </span>
                  </button>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className="text-neutral-500 hover:text-neutral-200 transition-colors"
                    title={isExpanded ? "Recolher" : "Expandir"}
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => startEdit(item)}
                    className="text-neutral-500 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-all"
                    title="Editar descricao e instrucoes"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Remover"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 border-t border-white/5 pt-3 space-y-3 bg-black/20">
                    {isEditing ? (
                      <>
                        <div>
                          <Label className="text-xs">Titulo</Label>
                          <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                        </div>
                        <div>
                          <Label className="text-xs">Descricao (o que este material contem)</Label>
                          <Textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            rows={2}
                            placeholder={DESCRIPTION_PLACEHOLDER}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Instrucoes para a IA (como usar este material)</Label>
                          <Textarea
                            value={editUsage}
                            onChange={(e) => setEditUsage(e.target.value)}
                            rows={4}
                            placeholder={INSTRUCTION_PLACEHOLDER}
                          />
                          <p className="text-[10px] text-neutral-400 mt-1">
                            Estas instrucoes sao enviadas junto com o conteudo para a IA e orientam como ela deve aplicar este item especifico.
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={savingEdit || !editTitle}>
                            {savingEdit ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                            Salvar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit}>Cancelar</Button>
                        </div>
                      </>
                    ) : (
                      <>
                        {item.description ? (
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-violet-400/80 font-semibold mb-1">Descricao</p>
                            <p className="text-xs text-neutral-300 whitespace-pre-wrap leading-relaxed">{item.description}</p>
                          </div>
                        ) : null}
                        {item.usage_instructions ? (
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-violet-400/80 font-semibold mb-1">Instrucoes para a IA</p>
                            <p className="text-xs text-neutral-300 whitespace-pre-wrap leading-relaxed">{item.usage_instructions}</p>
                          </div>
                        ) : null}
                        {!hasMeta && (
                          <p className="text-xs text-neutral-500 italic">
                            Nenhuma instrucao definida. Clique no lapis para orientar a IA sobre como usar este material.
                          </p>
                        )}
                        {item.type === "url" && item.file_url && (
                          <p className="text-[10px] text-neutral-500 break-all font-mono">{item.file_url}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
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
                  className="flex flex-col items-center gap-2 p-4 border border-dashed border-white/10 rounded-xl bg-white/[0.02] hover:border-violet-500/40 hover:bg-violet-500/5 transition-all duration-200 group"
                >
                  <Type className="w-5 h-5 text-neutral-400 group-hover:text-violet-300 transition-colors" />
                  <span className="text-sm font-medium text-neutral-100">Texto</span>
                  <span className="text-[10px] text-neutral-500">Cole conteudo diretamente</span>
                </button>
                <button
                  onClick={() => setAddType("file")}
                  className="flex flex-col items-center gap-2 p-4 border border-dashed border-white/10 rounded-xl bg-white/[0.02] hover:border-violet-500/40 hover:bg-violet-500/5 transition-all duration-200 group"
                >
                  <Upload className="w-5 h-5 text-neutral-400 group-hover:text-violet-300 transition-colors" />
                  <span className="text-sm font-medium text-neutral-100">Arquivo</span>
                  <span className="text-[10px] text-neutral-500">PDF, TXT, DOC, CSV</span>
                </button>
                <button
                  onClick={() => setAddType("url")}
                  className="flex flex-col items-center gap-2 p-4 border border-dashed border-white/10 rounded-xl bg-white/[0.02] hover:border-violet-500/40 hover:bg-violet-500/5 transition-all duration-200 group"
                >
                  <Globe className="w-5 h-5 text-neutral-400 group-hover:text-violet-300 transition-colors" />
                  <span className="text-sm font-medium text-neutral-100">URL</span>
                  <span className="text-[10px] text-neutral-500">Importar de um site</span>
                </button>
              </div>
            ) : (
              <>
                {addType === "text" && (
                  <>
                    <div>
                      <Label className="text-xs">Titulo</Label>
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Informacoes sobre produtos" />
                    </div>
                    <div>
                      <Label className="text-xs">Conteudo</Label>
                      <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder="Cole aqui o texto que a IA deve usar como referencia..." />
                    </div>
                  </>
                )}

                {addType === "file" && (
                  <>
                    <div>
                      <Label className="text-xs">Titulo (opcional)</Label>
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nome do documento" />
                    </div>
                  </>
                )}

                {addType === "url" && (
                  <>
                    <div>
                      <Label className="text-xs">Titulo</Label>
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Site da empresa" />
                    </div>
                    <div>
                      <Label className="text-xs">URL</Label>
                      <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="https://..." />
                      <p className="text-[10px] text-neutral-400 mt-1">O sistema vai extrair o texto do site automaticamente</p>
                    </div>
                  </>
                )}

                {/* Campos comuns: descricao + instrucoes */}
                <div className="pt-2 border-t border-neutral-100 space-y-3">
                  <div>
                    <Label className="text-xs">Descricao (o que este material contem)</Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                      placeholder={DESCRIPTION_PLACEHOLDER}
                    />
                    <p className="text-[10px] text-neutral-400 mt-1">
                      Ajuda voce a identificar o item depois. Tambem eh enviada para a IA como contexto.
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs">Instrucoes para a IA (como usar este material)</Label>
                    <Textarea
                      value={usageInstructions}
                      onChange={(e) => setUsageInstructions(e.target.value)}
                      rows={4}
                      placeholder={INSTRUCTION_PLACEHOLDER}
                    />
                    <p className="text-[10px] text-neutral-400 mt-1">
                      Seja especifico: diga quando usar, o que extrair e o que evitar. Ex: "Quando o lead perguntar sobre prazos, cite exatamente os valores da tabela. Nao fale em desconto — nao eh oferecido."
                    </p>
                  </div>
                </div>

                {addType === "file" ? (
                  <>
                    <Label className="text-xs">Arquivo</Label>
                    <Input type="file" accept=".pdf,.txt,.doc,.docx,.csv,.md" onChange={handleUploadFile} disabled={uploading} />
                    {uploading && <p className="text-xs text-neutral-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Processando arquivo...</p>}
                    <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
                  </>
                ) : addType === "text" ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleAddText} disabled={!title || !content || uploading}>
                      {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                      Adicionar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleAddUrl} disabled={!title || !content || uploading}>
                      {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                      Importar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={resetForm}>Cancelar</Button>
                  </div>
                )}
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
