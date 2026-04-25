"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, RotateCcw, Loader2, Bot, User, Clock, Zap, Wrench, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface ToolCallDetail {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
}

interface TestMessage {
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  model?: string;
  tokens?: { prompt: number; completion: number; cached: number };
  tools?: string[];
  tool_calls?: ToolCallDetail[];
  duration_ms?: number;
  error?: string;
  // Proativo: msg disparada por uma regra (não foi resposta a comando do rep)
  alert_type?: string;
  is_proactive?: boolean;
}

interface RepInfo {
  id: string;
  phone: string;
  display_name: string | null;
  ghl_users: Array<{ location_id: string; location_name: string | null }>;
  active_location_id: string | null;
}

interface SparkbotTesterProps {
  agentId: string; // Sparkbot agent id — session é por (agent_id + location_id do admin)
}

/**
 * Tester do Sparkbot. Mantém sessões persistentes no DB (agent_test_sessions
 * + agent_test_messages) pra preservar histórico entre msgs. Mesmo padrão do
 * agent-tester do sales/recruitment.
 */
export function SparkbotTester({ agentId }: SparkbotTesterProps) {
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [repInfo, setRepInfo] = useState<RepInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugDump, setDebugDump] = useState<unknown>(null);
  const [repPhone, setRepPhone] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const storageKey = `sparkbot-test-session:${agentId}`;

  // Carrega sessão persistida (se existir) ao montar / trocar agente
  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agents/test/sessions/${id}`);
      if (!res.ok) {
        localStorage.removeItem(storageKey);
        setSessionId(null);
        setMessages([]);
        return;
      }
      const data = await res.json();
      setSessionId(data.session.id);
      interface DbMsg {
        id: string;
        role: "user" | "agent";
        content: string;
        created_at: string;
        metadata?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          cached_tokens?: number;
          duration_ms?: number;
          tools?: string[];
          tool_calls?: ToolCallDetail[];
          model?: string;
          alert_type?: string;
          is_proactive?: boolean;
        };
      }
      const loaded: TestMessage[] = (data.messages || []).map((m: DbMsg) => ({
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at),
        tokens: m.metadata?.prompt_tokens !== undefined
          ? {
              prompt: m.metadata.prompt_tokens,
              completion: m.metadata.completion_tokens || 0,
              cached: m.metadata.cached_tokens || 0,
            }
          : undefined,
        duration_ms: m.metadata?.duration_ms,
        tools: m.metadata?.tools,
        tool_calls: m.metadata?.tool_calls,
        model: m.metadata?.model,
        alert_type: m.metadata?.alert_type,
        is_proactive: m.metadata?.is_proactive,
      }));
      setMessages(loaded);
    } catch {
      setSessionId(null);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!agentId) return;
    setMessages([]);
    setError(null);
    setDebugDump(null);

    const cached = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
    if (cached) {
      loadSession(cached);
    } else {
      setSessionId(null);
    }
  }, [agentId, storageKey, loadSession]);

  useEffect(() => {
    const container = messagesEndRef.current?.parentElement;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: new Date() }]);
    setInput("");
    setLoading(true);
    setError(null);
    setDebugDump(null);

    try {
      const res = await fetch("/api/agents/account-assistant/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: sessionId,
          ...(repPhone.trim() ? { rep_phone: repPhone.trim() } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Erro na chamada");
        if (data.debug) setDebugDump(data.debug);
        setMessages((prev) => [
          ...prev,
          { role: "agent", content: `⚠️ ${data.error}`, timestamp: new Date(), error: data.error },
        ]);
        setLoading(false);
        return;
      }

      // Persiste session_id (primeiro envio sempre cria sessão)
      if (data.session_id && data.session_id !== sessionId) {
        setSessionId(data.session_id);
        localStorage.setItem(storageKey, data.session_id);
      }

      if (data.rep && !repInfo) setRepInfo(data.rep);

      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: data.response,
          timestamp: new Date(),
          model: data.model_used,
          tokens: data.tokens,
          tools: data.tools_executed,
          tool_calls: data.tool_calls,
          duration_ms: data.duration_ms,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro de conexão");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    // Deleta sessão do DB (cascade apaga messages) e limpa localStorage
    if (sessionId) {
      try {
        await fetch(`/api/agents/test/sessions/${sessionId}`, { method: "DELETE" });
      } catch { /* non-critical */ }
    }
    localStorage.removeItem(storageKey);
    setSessionId(null);
    setMessages([]);
    setError(null);
    setDebugDump(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Chat */}
      <div className="col-span-2">
        <Card className="flex flex-col h-[600px]">
          <CardHeader className="pb-3 flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Teste o Sparkbot</CardTitle>
              <CardDescription>
                Conversa simulando você como rep. Sessão persistida — refresh não perde contexto.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleReset} disabled={messages.length === 0 && !sessionId}>
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Nova sessão
            </Button>
          </CardHeader>

          <CardContent className="flex-1 overflow-y-auto space-y-3 pb-0">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-sm">
                  <p className="text-sm text-gray-500 mb-2">
                    Manda uma mensagem pra testar o Sparkbot.
                  </p>
                  <p className="text-xs text-gray-400">
                    Exemplos:<br />
                    <span className="font-mono">quais meus appointments hoje?</span><br />
                    <span className="font-mono">busca contato Maria</span><br />
                    <span className="font-mono">cria nota no João: ele pediu proposta</span>
                  </p>
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "agent" && (
                  <div className="w-7 h-7 rounded-full brand-gradient flex items-center justify-center flex-shrink-0 mt-0.5 shadow-[0_2px_8px_-2px_rgba(22,117,242,0.45)]">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
                <div
                  className={
                    msg.role === "user"
                      ? "max-w-[80%] bg-brand-500 text-white rounded-2xl rounded-br-md px-4 py-2.5"
                      : "space-y-1.5 max-w-[85%]"
                  }
                >
                  {msg.role === "agent" ? (
                    <>
                      {msg.is_proactive && (
                        <div className="flex items-center gap-1 px-1 mb-1">
                          <Badge className="text-[10px] h-5 bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100">
                            ⚡ Proativo · {msg.alert_type || "alerta"}
                          </Badge>
                        </div>
                      )}
                      <div
                        className={`rounded-2xl rounded-bl-md px-4 py-2.5 whitespace-pre-wrap ${
                          msg.error
                            ? "bg-red-50 border border-red-200"
                            : msg.is_proactive
                            ? "bg-amber-50 border border-amber-200"
                            : "bg-gray-50"
                        }`}
                      >
                        <p className="text-sm text-gray-900">{msg.content}</p>
                      </div>

                      {msg.tool_calls && msg.tool_calls.length > 0 ? (
                        <details className="px-1">
                          <summary className="cursor-pointer flex flex-wrap gap-1 list-none">
                            {msg.tool_calls.map((tc, j) => {
                              const isError =
                                typeof tc.result === "object" &&
                                tc.result !== null &&
                                (tc.result as { status?: string }).status === "error";
                              return (
                                <Badge
                                  key={j}
                                  variant={isError ? "destructive" : "secondary"}
                                  className="text-[11px] h-5"
                                >
                                  <Wrench className="w-2.5 h-2.5 mr-1" />
                                  {tc.name}
                                  {isError && " ❌"}
                                </Badge>
                              );
                            })}
                            <span className="text-[10px] text-gray-400 ml-1">(ver detalhes)</span>
                          </summary>
                          <div className="mt-2 space-y-2">
                            {msg.tool_calls.map((tc, j) => (
                              <div
                                key={j}
                                className="text-[10px] bg-white border border-gray-200 rounded p-2"
                              >
                                <div className="font-mono font-semibold text-gray-700 mb-1">
                                  {tc.name}
                                </div>
                                <div className="text-gray-500 mb-0.5">input:</div>
                                <pre className="bg-gray-50 p-1.5 rounded overflow-auto max-h-32">
                                  {JSON.stringify(tc.input, null, 2)}
                                </pre>
                                <div className="text-gray-500 mt-1.5 mb-0.5">result:</div>
                                <pre className="bg-gray-50 p-1.5 rounded overflow-auto max-h-48">
                                  {JSON.stringify(tc.result, null, 2)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : msg.tools && msg.tools.length > 0 ? (
                        <div className="flex flex-wrap gap-1 px-1">
                          {msg.tools.map((t, j) => (
                            <Badge key={j} variant="secondary" className="text-[11px] h-5">
                              <Wrench className="w-2.5 h-2.5 mr-1" />
                              {t}
                            </Badge>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex items-center gap-3 px-1 text-[11px] text-gray-500 flex-wrap">
                        {msg.duration_ms !== undefined && (
                          <span className="flex items-center gap-0.5">
                            <Clock className="w-2.5 h-2.5" />
                            {(msg.duration_ms / 1000).toFixed(1)}s
                          </span>
                        )}
                        {msg.tokens && (
                          <span className="flex items-center gap-0.5">
                            <Zap className="w-2.5 h-2.5" />
                            {msg.tokens.prompt + msg.tokens.completion}tok
                            {msg.tokens.cached > 0 && msg.tokens.prompt > 0 && (
                              <span className="text-emerald-600">
                                {" "}(cache {Math.round((msg.tokens.cached / msg.tokens.prompt) * 100)}%)
                              </span>
                            )}
                          </span>
                        )}
                        {msg.model && <span className="font-mono">{msg.model}</span>}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
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
                <div className="w-7 h-7 rounded-full brand-gradient flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="bg-gray-50 rounded-2xl rounded-bl-md px-4 py-2.5">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </CardContent>

          <div className="p-3 border-t border-gray-200">
            <div className="flex gap-1.5">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Mande como se fosse um rep no WhatsApp..."
                disabled={loading}
                className="flex-1"
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                size="icon"
                className="h-9 w-9 flex-shrink-0"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
            {sessionId && (
              <p className="text-[10px] text-gray-400 mt-1.5 font-mono">
                Sessão: {sessionId.substring(0, 8)}…
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Sidebar */}
      <div className="space-y-3">
        {error && (
          <Card className="border-red-200 bg-red-50/50">
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-900">Erro</p>
                  <p className="text-xs text-red-700 mt-1 break-words">{error}</p>
                  {debugDump !== null && (
                    <details className="mt-2">
                      <summary className="text-[11px] text-red-700 cursor-pointer">debug info</summary>
                      <pre className="mt-1 text-[10px] bg-white p-2 rounded overflow-auto max-h-40">
                        {JSON.stringify(debugDump, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Phone do rep (override)</CardTitle>
            <CardDescription>
              Use se teu user GHL não tem phone cadastrado.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={repPhone}
              onChange={(e) => setRepPhone(e.target.value)}
              placeholder="+5511987654321"
              className="text-sm"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Identidade</CardTitle>
            <CardDescription>Como o Sparkbot te identifica neste teste.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {repInfo ? (
              <>
                <div>
                  <span className="text-xs text-gray-500 block">Nome</span>
                  <span className="text-gray-900">{repInfo.display_name || "(sem nome)"}</span>
                </div>
                <div>
                  <span className="text-xs text-gray-500 block">Phone</span>
                  <span className="text-gray-900 font-mono">{repInfo.phone}</span>
                </div>
                <div>
                  <span className="text-xs text-gray-500 block">Locations vinculadas</span>
                  <ul className="list-disc pl-4 text-gray-900">
                    {repInfo.ghl_users.map((u, i) => (
                      <li key={i}>
                        {u.location_name || u.location_id}
                        {repInfo.active_location_id === u.location_id && (
                          <Badge variant="secondary" className="ml-1 text-[10px]">ativa</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <p className="text-gray-500 text-xs">Manda uma mensagem pra identificar.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Como funciona</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-gray-600">
            <p>Esta aba simula você como rep no WhatsApp.</p>
            <p>A sessão é persistida: o Sparkbot lembra do contexto entre msgs. Refresh não perde nada.</p>
            <p>Ações que o bot executar <strong>são reais no GHL</strong> (cria nota, task, etc).</p>
            <p>Use &ldquo;Nova sessão&rdquo; pra começar do zero.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
