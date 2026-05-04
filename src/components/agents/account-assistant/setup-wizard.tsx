"use client";

/**
 * Setup Wizard do SparkBot — aparece em destaque acima das tabs no AI Hub
 * quando o admin/rep ainda não interagiu com o bot. Mostra QR code do
 * número WhatsApp + instruções claras pra começar.
 *
 * Quando primeira msg do rep chega, polling detecta e remove wizard.
 *
 * Pedro 2026-05-04: pedido pra reduzir fricção de primeiro uso. Anti-spam
 * WhatsApp exige que o REP inicie a conversa (bot não pode mandar msg
 * proativa antes de receber inbound).
 */

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, MessageCircle, CheckCircle2, Copy, Check } from "lucide-react";
import { toast } from "sonner";

interface OnboardingStatus {
  ok: boolean;
  first_time: boolean;
  whatsapp_number: string;
  rep_id: string | null;
  has_messages: boolean;
  last_msg_at: string | null;
  reason_no_phone?: boolean;
}

const POLL_INTERVAL_MS = 5000;

export function SetupWizard() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Estado pós-detecção: mostra "✅ Ativado!" por 3s antes de sumir
  const [justActivated, setJustActivated] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/sparkbot/onboarding-status");
      if (!res.ok) return;
      const data: OnboardingStatus = await res.json();
      setStatus((prev) => {
        // Detecta transição first_time=true → false (rep acabou de mandar msg)
        if (prev?.first_time === true && data.first_time === false) {
          setJustActivated(true);
        }
        return data;
      });
    } catch {
      /* silencia */
    } finally {
      setLoading(false);
    }
  }, []);

  // Mount: fetch status + setup polling
  useEffect(() => {
    fetchStatus();
    const iv = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [fetchStatus]);

  // Gera QR code quando status carrega e é first_time
  useEffect(() => {
    if (!status?.first_time || !status.whatsapp_number) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const url = waLink(status.whatsapp_number);
        const dataUrl = await QRCode.toDataURL(url, {
          width: 220,
          margin: 1,
          color: { dark: "#0F172A", light: "#FFFFFF" },
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch (err) {
        console.warn("[SetupWizard] QR gen failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.first_time, status?.whatsapp_number]);

  // "Ativado!" notif após 3s desaparece
  useEffect(() => {
    if (!justActivated) return;
    const t = setTimeout(() => setJustActivated(false), 3000);
    return () => clearTimeout(t);
  }, [justActivated]);

  const handleCopy = async () => {
    if (!status?.whatsapp_number) return;
    await navigator.clipboard.writeText(waLink(status.whatsapp_number));
    setCopied(true);
    toast.success("Link copiado");
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return null; // não mostra nada enquanto carrega — evita flash
  }

  // Já interagiu antes — só mostra notif transitória
  if (status && !status.first_time) {
    if (justActivated) {
      return (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <div className="text-sm">
              <p className="font-medium text-emerald-900">SparkBot ativado!</p>
              <p className="text-xs text-emerald-700">Você já pode usar pelo WhatsApp ou pelas tabs abaixo.</p>
            </div>
          </CardContent>
        </Card>
      );
    }
    return null; // não mostra nada — uso normal
  }

  // First time — mostra wizard
  if (!status) return null;

  return (
    <Card className="border-blue-200 bg-gradient-to-br from-blue-50 to-white">
      <CardContent className="p-6">
        <div className="flex flex-col md:flex-row gap-6 items-start">
          {/* QR Code */}
          <div className="flex flex-col items-center gap-2 flex-shrink-0">
            <div className="w-[220px] h-[220px] bg-white rounded-lg border border-blue-100 flex items-center justify-center overflow-hidden">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="QR Code WhatsApp SparkBot" className="w-full h-full" />
              ) : (
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              )}
            </div>
            <p className="text-xs text-gray-500">Escaneie pra abrir no WhatsApp</p>
          </div>

          {/* Instruções */}
          <div className="flex-1 space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-blue-600" />
                Ative o SparkBot
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                Pra começar, manda uma mensagem (qualquer texto, áudio ou foto) pro
                número do SparkBot no WhatsApp. Bot identifica você pelo seu phone
                cadastrado no GHL e responde com instruções.
              </p>
            </div>

            <div className="bg-white border border-blue-100 rounded-lg p-3 space-y-2">
              <p className="text-xs uppercase tracking-wider text-gray-500 font-medium">
                Número WhatsApp
              </p>
              <p className="text-base font-mono text-gray-900">
                {formatPhonePretty(status.whatsapp_number)}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="default"
                  asChild
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  <a href={waLink(status.whatsapp_number)} target="_blank" rel="noopener noreferrer">
                    Abrir WhatsApp
                  </a>
                </Button>
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 mr-1" />
                      Copiado
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" />
                      Copiar link
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="text-xs text-gray-500 space-y-1">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" />
                Aguardando primeira mensagem...
              </div>
              {status.reason_no_phone && (
                <p className="text-amber-700">
                  ⚠️ Seu phone não está cadastrado no GHL ainda. Cadastra em
                  Settings → My Profile pra que o bot consiga te identificar quando
                  você mandar mensagem.
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Constrói wa.me link com mensagem pré-preenchida pro rep clicar e
 * abrir WhatsApp já pronto pra mandar.
 */
function waLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const message = encodeURIComponent("Olá SparkBot, vamos começar!");
  return `https://wa.me/${digits}?text=${message}`;
}

/**
 * Formata "+18134079657" → "+1 (813) 407-9657"
 */
function formatPhonePretty(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}
