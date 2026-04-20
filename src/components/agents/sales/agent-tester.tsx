"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw, Loader2, Bot, User, Clock, Zap, AlertTriangle, CheckCircle2, ThumbsUp, ThumbsDown, Pencil, Trash2, X, Check, ChevronDown, Mic, Eye, FileText } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { composePersonalityProfile, type PersonalityProfile } from "@/lib/ai/behavior-blocks";
import type { AIResponse } from "@/types/ai";

interface ChatMessage {
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  actions?: AIResponse["actions"];
  collected_data?: Record<string, string>;
  status?: string;
  duration_ms?: number;
  tokens?: { prompt: number; completion: number };
  availableSlots?: string | null;
  actionsExecuted?: boolean;
  actionsError?: string | null;
}

interface SavedFeedback {
  id: string;
  rating: "positive" | "negative";
  ai_message: string;
  user_message: string | null;
  suggestion: string | null;
  created_at: string;
}

interface AgentTesterProps {
  agentId: string | null;
}

export function AgentTester({ agentId }: AgentTesterProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [collectedData, setCollectedData] = useState<Record<string, string>>({});
  const [executeActions, setExecuteActions] = useState(false);
  const [contactId, setContactId] = useState("");
  const [feedbackIdx, setFeedbackIdx] = useState<number | null>(null);
  const [feedbackSuggestion, setFeedbackSuggestion] = useState("");
  const [feedbackSent, setFeedbackSent] = useState<Set<number>>(new Set());
  const [savedFeedbacks, setSavedFeedbacks] = useState<SavedFeedback[]>([]);
  const [loadingFeedbacks, setLoadingFeedbacks] = useState(false);
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [editingSuggestion, setEditingSuggestion] = useState("");
  const [editingRating, setEditingRating] = useState<"positive" | "negative">("negative");
  const [profile, setProfile] = useState<PersonalityProfile | null>(null);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editValues, setEditValues] = useState({
    tone_creativity: 50,
    tone_formality: 50,
    tone_naturalness: 50,
    tone_aggressiveness: 50,
  });
  const [savingProfile, setSavingProfile] = useState(false);
  // Sidebar panels
  const [showPrompt, setShowPrompt] = useState(false);
  const [showKB, setShowKB] = useState(false);
  const [systemPromptPreview, setSystemPromptPreview] = useState("");
  const [kbItems, setKbItems] = useState<{ title: string; type: string; token_count: number }[]>([]);
  const [mediaToggles, setMediaToggles] = useState({ audio: false, image: false, pdf: false });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Carrega config do agente e resolve o perfil comportamental atual
  useEffect(() => {
    if (!agentId) return;
    fetch(`/api/agents/${agentId}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.config) return;
        const values = {
          tone_creativity: data.config.tone_creativity ?? 50,
          tone_formality: data.config.tone_formality ?? 50,
          tone_naturalness: data.config.tone_naturalness ?? 50,
          tone_aggressiveness: data.config.tone_aggressiveness ?? 50,
        };
        setEditValues(values);
        setProfile(composePersonalityProfile(values));
        // Media toggles
        setMediaToggles({
          audio: data.config.enable_audio_transcription ?? false,
          image: data.config.enable_image_analysis ?? false,
          pdf: data.config.enable_pdf_reading ?? false,
        });
        // System prompt preview
        if (data.config.system_prompt_override) {
          setSystemPromptPreview(data.config.system_prompt_override);
        } else if (data.config.custom_instructions) {
          setSystemPromptPreview(data.config.custom_instructions);
        }
      })
      .catch(() => {});

    // Fetch KB items
    fetch(`/api/knowledge-base?agent_id=${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.items) setKbItems(data.items.map((i: { title: string; type: string; token_count: number }) => ({ title: i.title, type: i.type, token_count: i.token_count })));
      })
      .catch(() => {});
  }, [agentId]);

  // Reset conversa ao trocar de agente
  useEffect(() => {
    setMessages([]);
    setCollectedData({});
    setInput("");
  }, [agentId]);

  const startEditProfile = () => setEditingProfile(true);

  const cancelEditProfile = () => {
    // Restaurar valores a partir do perfil atual
    if (profile) {
      setEditValues({
        tone_creativity: profile.creativity.percent,
        tone_formality: profile.formality.percent,
        tone_naturalness: profile.naturalness.percent,
        tone_aggressiveness: profile.aggressiveness.percent,
      });
    }
    setEditingProfile(false);
  };

  const saveEditProfile = async () => {
    if (!agentId) return;
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editValues),
      });
      if (res.ok) {
        setProfile(composePersonalityProfile(editValues));
        setEditingProfile(false);
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const fetchFeedbacks = useCallback(async () => {
    if (!agentId) return;
    setLoadingFeedbacks(true);
    try {
      const res = await fetch(`/api/feedback?agent_id=${agentId}`);
      if (res.ok) {
        const data = await res.json();
        setSavedFeedbacks(data.feedback || []);
      }
    } finally {
      setLoadingFeedbacks(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchFeedbacks();
  }, [fetchFeedbacks]);

  const sendFeedback = async (msgIndex: number, rating: "positive" | "negative", suggestion?: string) => {
    if (!agentId) return;
    const msg = messages[msgIndex];
    // Encontrar a mensagem do usuario anterior para contexto
    const userMsg = messages.slice(0, msgIndex).reverse().find((m) => m.role === "user");

    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        rating,
        ai_message: msg.content,
        user_message: userMsg?.content || "",
        suggestion: suggestion || null,
        context: buildHistory(),
      }),
    });

    setFeedbackSent((prev) => new Set(prev).add(msgIndex));
    setFeedbackIdx(null);
    setFeedbackSuggestion("");
    fetchFeedbacks();
  };

  const deleteFeedback = async (id: string) => {
    if (!agentId) return;
    const res = await fetch(`/api/feedback?id=${id}&agent_id=${agentId}`, { method: "DELETE" });
    if (res.ok) {
      setSavedFeedbacks((prev) => prev.filter((f) => f.id !== id));
    }
  };

  const startEditFeedback = (fb: SavedFeedback) => {
    setEditingFeedbackId(fb.id);
    setEditingSuggestion(fb.suggestion || "");
    setEditingRating(fb.rating);
  };

  const cancelEditFeedback = () => {
    setEditingFeedbackId(null);
    setEditingSuggestion("");
  };

  const saveEditFeedback = async () => {
    if (!editingFeedbackId) return;
    const res = await fetch("/api/feedback", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editingFeedbackId,
        agent_id: agentId,
        rating: editingRating,
        suggestion: editingRating === "negative" ? editingSuggestion : null,
      }),
    });
    if (res.ok) {
      setSavedFeedbacks((prev) =>
        prev.map((f) =>
          f.id === editingFeedbackId
            ? { ...f, rating: editingRating, suggestion: editingRating === "negative" ? editingSuggestion : null }
            : f
        )
      );
      cancelEditFeedback();
    }
  };

  useEffect(() => {
    // Scroll apenas dentro do container do chat, nao a pagina inteira
    const container = messagesEndRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const buildHistory = () => {
    // Excluir a ultima mensagem (a do usuario que esta sendo enviada agora)
    // para evitar duplicacao — ela ja vai como `message` no request.
    return messages
      .slice(0, -1)
      .map((m) => {
        const role = m.role === "user" ? "LEAD" : "AGENTE";
        return `${role}: ${m.content}`;
      })
      .join("\n");
  };

  const handleSend = async () => {
    if (!input.trim() || !agentId || loading) return;

    const userMessage = input.trim();
    setInput("");

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userMessage, timestamp: new Date() },
    ]);

    setLoading(true);

    try {
      const response = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          message: userMessage,
          conversation_history: buildHistory(),
          collected_data: collectedData,
          execute_actions: executeActions,
          contact_id: executeActions ? contactId : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "agent", content: `Erro: ${data.error}`, timestamp: new Date() },
        ]);
        return;
      }

      const aiResponse: AIResponse = data.response;

      if (aiResponse.collected_data) {
        setCollectedData((prev) => ({ ...prev, ...aiResponse.collected_data }));
      }

      let displayContent: string;
      if (Array.isArray(aiResponse.message)) {
        displayContent = aiResponse.message.join("\n");
      } else {
        displayContent = aiResponse.message;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: displayContent,
          timestamp: new Date(),
          actions: aiResponse.actions,
          collected_data: aiResponse.collected_data,
          status: aiResponse.conversation_status,
          duration_ms: data.duration_ms,
          tokens: {
            prompt: data.prompt_tokens || 0,
            completion: data.completion_tokens || 0,
          },
          availableSlots: data.available_slots,
          actionsExecuted: data.actions_executed,
          actionsError: data.actions_error,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "agent", content: "Erro de conexao com o servidor", timestamp: new Date() },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setCollectedData({});
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!agentId) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-sm text-gray-400">
            Salve a configuracao do agente primeiro para poder testa-lo.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toggle de acoes reais */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            <div className="flex items-center gap-3">
              <Switch
                checked={executeActions}
                onCheckedChange={setExecuteActions}
                id="execute-actions"
              />
              <div>
                <Label htmlFor="execute-actions" className="font-medium">
                  Executar acoes reais
                </Label>
                <p className="text-xs text-gray-500 mt-0.5">
                  {executeActions
                    ? "As acoes serao executadas de verdade no Spark (enviar mensagem, agendar, atualizar campos, tags)"
                    : "Modo simulacao — nenhuma acao sera executada no Spark"}
                </p>
              </div>
            </div>

            {executeActions && (
              <div className="flex-1 max-w-xs">
                <Label className="text-xs">Contact ID</Label>
                <Input
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  placeholder="Cole o ID do contato..."
                  className="mt-1"
                />
              </div>
            )}
          </div>

          {executeActions && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                Atencao: com acoes reais ativadas, o agente vai enviar mensagens,
                agendar reunioes e atualizar dados do contato no Spark.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {/* Chat */}
        <div className="col-span-2">
          <Card className="flex flex-col h-[550px]">
            <CardHeader className="pb-3 flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Conversa de teste</CardTitle>
                <CardDescription>
                  Simule uma conversa para testar o comportamento do agente
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="w-3.5 h-3.5 mr-2" />
                Resetar
              </Button>
            </CardHeader>

            {/* Messages */}
            <CardContent className="flex-1 overflow-y-auto space-y-3 pb-0">
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-gray-500">
                    Envie uma mensagem para iniciar o teste
                  </p>
                </div>
              )}

              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex gap-2.5 ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {msg.role === "agent" && (
                    <div className="w-7 h-7 rounded-full brand-gradient flex items-center justify-center flex-shrink-0 mt-0.5 shadow-[0_2px_8px_-2px_rgba(22,117,242,0.45)]">
                      <Bot className="w-3.5 h-3.5 text-white" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] ${
                      msg.role === "user"
                        ? "bg-brand-500 text-white rounded-2xl rounded-br-md px-4 py-2.5"
                        : "space-y-1.5"
                    }`}
                  >
                    {msg.role === "agent" ? (
                      <>
                        <div className="bg-gray-50 rounded-2xl rounded-bl-md px-4 py-2.5">
                          <p className="text-sm text-gray-900">{msg.content}</p>
                        </div>
                        {/* Meta info */}
                        <div className="flex items-center gap-2 px-1 flex-wrap">
                          {msg.duration_ms && (
                            <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
                              <Clock className="w-2.5 h-2.5" />
                              {(msg.duration_ms / 1000).toFixed(1)}s
                            </span>
                          )}
                          {msg.tokens && (
                            <span className="text-[10px] text-gray-500 flex items-center gap-0.5">
                              <Zap className="w-2.5 h-2.5" />
                              {msg.tokens.prompt + msg.tokens.completion} tokens
                            </span>
                          )}
                          {msg.status && msg.status !== "active" && (
                            <Badge variant="secondary" className="text-[10px] h-4">
                              {msg.status}
                            </Badge>
                          )}
                          {msg.actionsExecuted && (
                            <span className="text-[10px] text-emerald-600 flex items-center gap-0.5">
                              <CheckCircle2 className="w-2.5 h-2.5" />
                              Acoes executadas
                            </span>
                          )}
                          {msg.actionsError && (
                            <span className="text-[10px] text-red-500 flex items-center gap-0.5">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              {msg.actionsError}
                            </span>
                          )}
                        </div>
                        {/* Actions */}
                        {msg.actions && msg.actions.length > 0 && (
                          <div className="flex flex-wrap gap-1 px-1">
                            {msg.actions.map((action, j) => (
                              <Badge
                                key={j}
                                variant={msg.actionsExecuted ? "success" : "outline"}
                                className="text-[10px] h-4"
                              >
                                {action.type}
                                {action.tag ? `: ${action.tag}` : ""}
                                {action.field_key ? `: ${action.field_key}=${action.value}` : ""}
                                {action.start_time ? `: ${action.start_time}` : ""}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {/* Feedback buttons */}
                        {!feedbackSent.has(i) ? (
                          <div className="flex items-center gap-1 px-1 mt-1">
                            {feedbackIdx === i ? (
                              <div className="flex items-center gap-2 w-full">
                                <Input
                                  value={feedbackSuggestion}
                                  onChange={(e) => setFeedbackSuggestion(e.target.value)}
                                  placeholder="Como deveria ter respondido?"
                                  className="h-6 text-xs flex-1"
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      sendFeedback(i, "negative", feedbackSuggestion);
                                    }
                                  }}
                                />
                                <Button
                                  size="sm"
                                  className="h-6 text-[10px] px-2"
                                  onClick={() => sendFeedback(i, "negative", feedbackSuggestion)}
                                >
                                  Enviar
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-[10px] px-1"
                                  onClick={() => { setFeedbackIdx(null); setFeedbackSuggestion(""); }}
                                >
                                  Cancelar
                                </Button>
                              </div>
                            ) : (
                              <>
                                <button
                                  onClick={() => sendFeedback(i, "positive")}
                                  className="text-gray-700 hover:text-green-500 transition-colors"
                                  title="Boa resposta"
                                >
                                  <ThumbsUp className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => setFeedbackIdx(i)}
                                  className="text-gray-700 hover:text-red-500 transition-colors"
                                  title="Resposta ruim"
                                >
                                  <ThumbsDown className="w-3 h-3" />
                                </button>
                              </>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-700 px-1">Feedback salvo</span>
                        )}
                      </>
                    ) : (
                      <p className="text-sm">{msg.content}</p>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="w-3.5 h-3.5 text-gray-700" />
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex gap-2.5">
                  <div className="w-7 h-7 rounded-full brand-gradient flex items-center justify-center flex-shrink-0 shadow-[0_2px_8px_-2px_rgba(22,117,242,0.45)]">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="bg-gray-50 rounded-2xl rounded-bl-md px-4 py-2.5">
                    <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </CardContent>

            {/* Input */}
            <div className="p-4 border-t border-gray-200">
              {executeActions && !contactId && (
                <p className="text-xs text-amber-500 mb-2">
                  Informe o Contact ID acima para executar acoes reais
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Digite uma mensagem como lead..."
                  disabled={loading}
                />
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || loading || (executeActions && !contactId)}
                  size="icon"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        </div>

        {/* Sidebar - Recursos + Dados coletados + Perfil comportamental */}
        <div className="space-y-4">
          {/* Media Toggles */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Recursos de midia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mic className={`w-3.5 h-3.5 ${mediaToggles.audio ? "text-brand-600" : "text-gray-400"}`} />
                  <span className="text-xs">Audio</span>
                </div>
                <Badge variant={mediaToggles.audio ? "default" : "secondary"} className="text-[9px]">
                  {mediaToggles.audio ? "ON" : "OFF"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eye className={`w-3.5 h-3.5 ${mediaToggles.image ? "text-brand-600" : "text-gray-400"}`} />
                  <span className="text-xs">Imagem</span>
                </div>
                <Badge variant={mediaToggles.image ? "default" : "secondary"} className="text-[9px]">
                  {mediaToggles.image ? "ON" : "OFF"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className={`w-3.5 h-3.5 ${mediaToggles.pdf ? "text-brand-600" : "text-gray-400"}`} />
                  <span className="text-xs">PDF/Docs</span>
                </div>
                <Badge variant={mediaToggles.pdf ? "default" : "secondary"} className="text-[9px]">
                  {mediaToggles.pdf ? "ON" : "OFF"}
                </Badge>
              </div>
              <p className="text-[10px] text-gray-400 pt-1 border-t border-gray-100">
                Configure na aba Avancado
              </p>
            </CardContent>
          </Card>

          {/* Prompt Preview */}
          <Card>
            <button
              type="button"
              onClick={() => setShowPrompt(!showPrompt)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="text-sm font-semibold text-gray-900">Prompt / Instrucoes</span>
              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showPrompt ? "rotate-180" : ""}`} />
            </button>
            {showPrompt && (
              <CardContent className="pt-0 pb-3">
                <textarea
                  readOnly
                  value={systemPromptPreview || "(Usando prompt gerado automaticamente)"}
                  className="w-full h-[200px] text-[11px] font-mono text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3 resize-y focus:outline-none focus:ring-1 focus:ring-brand-300"
                />
                <p className="text-[10px] text-gray-400 mt-1">
                  {systemPromptPreview ? "Override ativo — edite na aba Prompt" : "Gerado automaticamente a partir das configs"}
                </p>
              </CardContent>
            )}
          </Card>

          {/* Knowledge Base */}
          <Card>
            <button
              type="button"
              onClick={() => setShowKB(!showKB)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">Knowledge Base</span>
                <Badge variant="secondary" className="text-[9px]">{kbItems.length} itens</Badge>
              </div>
              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showKB ? "rotate-180" : ""}`} />
            </button>
            {showKB && (
              <CardContent className="pt-0 pb-3 max-h-[200px] overflow-y-auto">
                {kbItems.length === 0 ? (
                  <p className="text-xs text-gray-400">Nenhum item na base. Adicione na aba Contexto.</p>
                ) : (
                  <div className="space-y-1.5">
                    {kbItems.map((item, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded bg-gray-50">
                        <span className="text-xs text-gray-700 truncate flex-1">{item.title}</span>
                        <span className="text-[9px] text-gray-400 flex-shrink-0 ml-2">~{item.token_count} tok</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Dados coletados */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Dados coletados</CardTitle>
              <CardDescription>
                Informacoes extraidas pela IA durante a conversa
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 max-h-[220px] overflow-y-auto">
              {Object.keys(collectedData).length === 0 ? (
                <p className="text-sm text-gray-500">Nenhum dado coletado ainda</p>
              ) : (
                Object.entries(collectedData).map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-gray-400">{key}</span>
                    <span className="text-sm text-gray-900 bg-gray-50 px-2 py-1 rounded">
                      {value || "-"}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Perfil comportamental</CardTitle>
                <CardDescription>
                  {editingProfile
                    ? "Ajuste os percentuais. Ao salvar, o proximo teste ja usa o novo perfil."
                    : "Blocos selecionados a partir dos percentuais. Clique no lapis para editar."}
                </CardDescription>
              </div>
              {!editingProfile && profile && (
                <button
                  type="button"
                  onClick={startEditProfile}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-brand-600 hover:bg-brand-50 transition-colors flex-shrink-0"
                  title="Editar perfil"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {!profile ? (
                <p className="text-xs text-gray-500">Carregando perfil...</p>
              ) : editingProfile ? (
                <div className="space-y-5">
                  {(
                    [
                      { key: "tone_creativity", title: "Criatividade", low: "Preciso", high: "Criativo" },
                      { key: "tone_formality", title: "Formalidade", low: "Informal", high: "Formal" },
                      { key: "tone_naturalness", title: "Naturalidade", low: "Robotico", high: "Humano" },
                      { key: "tone_aggressiveness", title: "Agressividade", low: "Passivo", high: "Agressivo" },
                    ] as const
                  ).map(({ key, title, low, high }) => {
                    const value = editValues[key];
                    return (
                      <div key={key}>
                        <div className="flex items-center justify-between mb-1.5">
                          <Label className="text-xs font-semibold text-gray-900">{title}</Label>
                          <span className="text-xs font-mono text-brand-600">{value}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400 w-14 truncate">{low}</span>
                          <Slider
                            value={[value]}
                            onValueChange={([v]) => setEditValues((prev) => ({ ...prev, [key]: v }))}
                            max={100}
                            step={5}
                            className="flex-1"
                          />
                          <span className="text-[10px] text-gray-400 w-14 truncate text-right">{high}</span>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex gap-2 pt-2 border-t border-gray-100">
                    <Button size="sm" onClick={saveEditProfile} disabled={savingProfile} className="flex-1">
                      {savingProfile ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5 mr-1" />
                      )}
                      Salvar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEditProfile} disabled={savingProfile}>
                      <X className="w-3.5 h-3.5 mr-1" />
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                (
                  [
                    { key: "creativity", title: "Criatividade" },
                    { key: "formality", title: "Formalidade" },
                    { key: "naturalness", title: "Naturalidade" },
                    { key: "aggressiveness", title: "Agressividade" },
                  ] as const
                ).map(({ key, title }) => {
                  const block = profile[key];
                  const isOpen = expandedBlock === key;
                  return (
                    <div key={key} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpandedBlock(isOpen ? null : key)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-gray-900">{title}</span>
                            <span className="text-[11px] font-mono text-brand-600">{block.percent}%</span>
                          </div>
                          <span className="text-[11px] text-gray-500 block truncate">{block.label} · {block.summary}</span>
                        </div>
                        <span className="text-[10px] uppercase tracking-wider text-brand-500/80 font-medium flex-shrink-0">
                          {isOpen ? "Fechar" : "Ver"}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="px-3 pb-3 pt-1 border-t border-gray-100 bg-gray-50/60">
                          <pre className="text-[11px] text-gray-700 whitespace-pre-wrap leading-relaxed font-sans">
                            {block.directives}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Feedbacks registrados */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Feedbacks registrados</CardTitle>
          <CardDescription>
            Positivos reforcam o estilo que a IA deve repetir. Negativos incluem como
            deveria ter respondido e a IA aprende com eles. Vc pode editar ou apagar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingFeedbacks ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
            </div>
          ) : savedFeedbacks.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nenhum feedback registrado. Use os botoes de curtir/descurtir nas respostas do agente acima.
            </p>
          ) : (
            <div className="space-y-2">
              {savedFeedbacks.map((fb) => {
                const isEditing = editingFeedbackId === fb.id;
                return (
                  <div
                    key={fb.id}
                    className={`border rounded-lg p-3 ${
                      fb.rating === "positive"
                        ? "border-green-200 bg-emerald-50/40"
                        : "border-red-200 bg-red-50/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setEditingRating("positive")}
                              className={`p-1 rounded ${editingRating === "positive" ? "bg-emerald-100 text-emerald-600" : "text-gray-700"}`}
                              title="Marcar como positivo"
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingRating("negative")}
                              className={`p-1 rounded ${editingRating === "negative" ? "bg-red-100 text-red-600" : "text-gray-700"}`}
                              title="Marcar como negativo"
                            >
                              <ThumbsDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : fb.rating === "positive" ? (
                          <Badge variant="success" className="text-[10px]">
                            <ThumbsUp className="w-2.5 h-2.5 mr-1" />
                            Positivo
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">
                            <ThumbsDown className="w-2.5 h-2.5 mr-1" />
                            Negativo
                          </Badge>
                        )}
                        <span className="text-xs text-gray-500">                          {new Date(fb.created_at).toLocaleString("pt-BR", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {isEditing ? (
                          <>
                            <button
                              onClick={saveEditFeedback}
                              className="text-gray-500 hover:text-emerald-600 transition-colors"
                              title="Salvar"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={cancelEditFeedback}
                              className="text-gray-500 hover:text-gray-700 transition-colors"
                              title="Cancelar"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditFeedback(fb)}
                              className="text-gray-700 hover:text-gray-800 transition-colors"
                              title="Editar"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deleteFeedback(fb.id)}
                              className="text-gray-700 hover:text-red-500 transition-colors"
                              title="Apagar"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {fb.user_message && (
                      <div className="mb-2">
                        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                          Lead disse
                        </span>
                        <p className="text-sm text-gray-800 mt-1 italic">&ldquo;{fb.user_message}&rdquo;</p>
                      </div>
                    )}

                    <div className="mb-2">
                      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                        IA respondeu
                      </span>
                      <p className="text-sm text-gray-900 mt-1">{fb.ai_message}</p>
                    </div>

                    {isEditing ? (
                      editingRating === "negative" && (
                        <div>
                          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                            Como deveria ter respondido
                          </span>
                          <Textarea
                            value={editingSuggestion}
                            onChange={(e) => setEditingSuggestion(e.target.value)}
                            placeholder="Instrucao de correcao..."
                            rows={2}
                            className="mt-1 text-xs"
                          />
                        </div>
                      )
                    ) : (
                      fb.suggestion && (
                        <div className="bg-gray-50 border border-gray-200 rounded p-2">
                          <span className="text-[11px] font-semibold text-red-600 uppercase tracking-wide">
                            Correcao (deveria ser)
                          </span>
                          <p className="text-sm text-gray-900 mt-1">{fb.suggestion}</p>
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
