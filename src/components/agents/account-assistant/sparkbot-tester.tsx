"use client";

import { useState, useRef, useEffect } from "react";
import { Send, RotateCcw, Loader2, Bot, User, Clock, Zap, Wrench, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface TestMessage {
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  model?: string;
  tokens?: { prompt: number; completion: number; cached: number };
  tools?: string[];
  duration_ms?: number;
  error?: string;
}

interface RepInfo {
  id: string;
  phone: string;
  display_name: string | null;
  ghl_users: Array<{ location_id: string; location_name: string | null }>;
  active_location_id: string | null;
}

/**
 * Tester do Sparkbot. Chat simplificado que chama o endpoint de teste
 * e exibe resposta + tools chamadas + metadados.
 */
export function SparkbotTester() {
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [repInfo, setRepInfo] = useState<RepInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

    try {
      const res = await fetch("/api/agents/account-assistant/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Erro na chamada");
        setMessages((prev) => [
          ...prev,
          { role: "agent", content: `⚠️ ${data.error}`, timestamp: new Date(), error: data.error },
        ]);
        setLoading(false);
        return;
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
          duration_ms: data.duration_ms,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro de conexão");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setError(null);
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
                Conversa simulando você como rep. Usa seu phone do GHL pra identificar.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleReset} disabled={messages.length === 0}>
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Limpar
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
                      <div
                        className={`rounded-2xl rounded-bl-md px-4 py-2.5 whitespace-pre-wrap ${
                          msg.error ? "bg-red-50 border border-red-200" : "bg-gray-50"
                        }`}
                      >
                        <p className="text-sm text-gray-900">{msg.content}</p>
                      </div>

                      {/* Tools chamadas */}
                      {msg.tools && msg.tools.length > 0 && (
                        <div className="flex flex-wrap gap-1 px-1">
                          {msg.tools.map((t, j) => (
                            <Badge key={j} variant="secondary" className="text-[11px] h-5">
                              <Wrench className="w-2.5 h-2.5 mr-1" />
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* Metadados */}
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
                            {msg.tokens.cached > 0 && (
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
                <div>
                  <p className="text-sm font-medium text-red-900">Erro</p>
                  <p className="text-xs text-red-700 mt-1 break-words">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
            <CardTitle className="text-base">Como funciona o teste</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-gray-600">
            <p>Esta aba simula você como rep conversando com o Sparkbot no WhatsApp.</p>
            <p>O fluxo real (identificação → tools → GHL → resposta) roda igualzinho, exceto que a resposta aparece aqui em vez de ir pro WhatsApp.</p>
            <p>As ações que o bot executar <strong>são reais no GHL</strong> (cria nota, task, etc). Cuidado.</p>
            <p>Termos de uso são aceitos automaticamente em modo teste.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
