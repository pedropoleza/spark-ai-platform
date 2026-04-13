"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw, Loader2, Bot, User, Clock, Zap, AlertTriangle, CheckCircle2, ThumbsUp, ThumbsDown, Pencil, Trash2, X, Check } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    const res = await fetch(`/api/feedback?id=${id}`, { method: "DELETE" });
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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const buildHistory = () => {
    return messages
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

      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: Array.isArray(aiResponse.message)
            ? aiResponse.message.join("\n")
            : aiResponse.message || "(sem mensagem)",
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
          <p className="text-sm text-neutral-500">
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
                <p className="text-xs text-neutral-400 mt-0.5">
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
                  <p className="text-sm text-neutral-400">
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
                    <div className="w-7 h-7 rounded-full bg-neutral-900 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-white" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] ${
                      msg.role === "user"
                        ? "bg-neutral-900 text-white rounded-2xl rounded-br-md px-4 py-2.5"
                        : "space-y-1.5"
                    }`}
                  >
                    {msg.role === "agent" ? (
                      <>
                        <div className="bg-neutral-100 rounded-2xl rounded-bl-md px-4 py-2.5">
                          <p className="text-sm text-neutral-900">{msg.content}</p>
                        </div>
                        {/* Meta info */}
                        <div className="flex items-center gap-2 px-1 flex-wrap">
                          {msg.duration_ms && (
                            <span className="text-[10px] text-neutral-400 flex items-center gap-0.5">
                              <Clock className="w-2.5 h-2.5" />
                              {(msg.duration_ms / 1000).toFixed(1)}s
                            </span>
                          )}
                          {msg.tokens && (
                            <span className="text-[10px] text-neutral-400 flex items-center gap-0.5">
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
                            <span className="text-[10px] text-green-600 flex items-center gap-0.5">
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
                                  className="text-neutral-300 hover:text-green-500 transition-colors"
                                  title="Boa resposta"
                                >
                                  <ThumbsUp className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => setFeedbackIdx(i)}
                                  className="text-neutral-300 hover:text-red-500 transition-colors"
                                  title="Resposta ruim"
                                >
                                  <ThumbsDown className="w-3 h-3" />
                                </button>
                              </>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-neutral-300 px-1">Feedback salvo</span>
                        )}
                      </>
                    ) : (
                      <p className="text-sm">{msg.content}</p>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="w-7 h-7 rounded-full bg-neutral-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="w-3.5 h-3.5 text-neutral-600" />
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-neutral-900 flex items-center justify-center flex-shrink-0">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="bg-neutral-100 rounded-2xl rounded-bl-md px-4 py-2.5">
                    <Loader2 className="w-4 h-4 animate-spin text-neutral-400" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </CardContent>

            {/* Input */}
            <div className="p-4 border-t border-neutral-200">
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

        {/* Sidebar - Dados coletados */}
        <div>
          <Card className="h-[550px] overflow-y-auto">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Dados coletados</CardTitle>
              <CardDescription>
                Informacoes extraidas pela IA durante a conversa
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {Object.keys(collectedData).length === 0 ? (
                <p className="text-sm text-neutral-400">Nenhum dado coletado ainda</p>
              ) : (
                Object.entries(collectedData).map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-neutral-500">{key}</span>
                    <span className="text-sm text-neutral-900 bg-neutral-50 px-2 py-1 rounded">
                      {value || "-"}
                    </span>
                  </div>
                ))
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
              <Loader2 className="w-4 h-4 animate-spin text-neutral-400" />
            </div>
          ) : savedFeedbacks.length === 0 ? (
            <p className="text-sm text-neutral-400">
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
                        ? "border-green-200 bg-green-50/40"
                        : "border-red-200 bg-red-50/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setEditingRating("positive")}
                              className={`p-1 rounded ${editingRating === "positive" ? "bg-green-100 text-green-600" : "text-neutral-300"}`}
                              title="Marcar como positivo"
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingRating("negative")}
                              className={`p-1 rounded ${editingRating === "negative" ? "bg-red-100 text-red-600" : "text-neutral-300"}`}
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
                        <span className="text-[10px] text-neutral-400">
                          {new Date(fb.created_at).toLocaleString("pt-BR", {
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
                              className="text-neutral-400 hover:text-green-600 transition-colors"
                              title="Salvar"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={cancelEditFeedback}
                              className="text-neutral-400 hover:text-neutral-600 transition-colors"
                              title="Cancelar"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditFeedback(fb)}
                              className="text-neutral-300 hover:text-neutral-700 transition-colors"
                              title="Editar"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => deleteFeedback(fb.id)}
                              className="text-neutral-300 hover:text-red-500 transition-colors"
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
                        <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">
                          Lead disse
                        </span>
                        <p className="text-xs text-neutral-700 mt-0.5 italic">&ldquo;{fb.user_message}&rdquo;</p>
                      </div>
                    )}

                    <div className="mb-2">
                      <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">
                        IA respondeu
                      </span>
                      <p className="text-xs text-neutral-900 mt-0.5">{fb.ai_message}</p>
                    </div>

                    {isEditing ? (
                      editingRating === "negative" && (
                        <div>
                          <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">
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
                        <div className="bg-white border border-neutral-200 rounded p-2">
                          <span className="text-[10px] font-medium text-red-600 uppercase tracking-wide">
                            Correcao (deveria ser)
                          </span>
                          <p className="text-xs text-neutral-900 mt-0.5">{fb.suggestion}</p>
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
