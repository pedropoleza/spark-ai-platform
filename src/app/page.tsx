"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

const IS_DEV_MODE = process.env.NEXT_PUBLIC_DEV_MODE === "true";

function SSOHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Autenticando...");
  const [devLoading, setDevLoading] = useState(false);
  const authenticatedRef = useRef(false);

  // Fix bug observado em prod 2026-06-02 (F42): default era "/dashboard" — depois
  // do cutover PM-F3.I (next.config.mjs 308 → /hub), isso virava um redirect
  // a mais e às vezes loopava com o gate antigo do /hub. Default agora é /hub
  // direto. ?next= ainda funciona pra deep-links específicos.
  const computeTarget = useCallback(() => {
    const next = searchParams.get("next") || "/hub";
    const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/hub";
    return safe;
  }, [searchParams]);

  const devLogin = useCallback(async () => {
    if (authenticatedRef.current) return;
    setDevLoading(true);
    try {
      const response = await fetch("/api/auth/dev-login", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Dev login falhou");
        setDevLoading(false);
        return;
      }
      authenticatedRef.current = true;
      router.replace(computeTarget());
    } catch {
      setError("Erro de conexão no dev-login.");
      setDevLoading(false);
    }
  }, [router, computeTarget]);

  const authenticate = useCallback(
    async (userId: string, companyId: string, locationId: string) => {
      if (authenticatedRef.current) return;
      authenticatedRef.current = true;

      setStatus("Validando credenciais...");

      try {
        const response = await fetch("/api/auth/sso", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            company_id: companyId,
            location_id: locationId,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          setError(data.error || "Erro ao autenticar");
          authenticatedRef.current = false;
          return;
        }

        setStatus("Redirecionando...");
        router.replace(computeTarget());
      } catch {
        setError("Erro de conexão. Tente novamente.");
        authenticatedRef.current = false;
      }
    },
    [router, computeTarget]
  );

  useEffect(() => {
    const COMPANY_ID = process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "";

    // 1. Tentar via query params (ex: ?user_id=X&location_id=Z)
    const userId = searchParams.get("user_id") || searchParams.get("userId");
    const locationId = searchParams.get("location_id") || searchParams.get("locationId");

    if (userId && locationId) {
      authenticate(userId, COMPANY_ID, locationId);
      return;
    }

    // 2. Escutar postMessage do GHL (Custom Menu Link envia dados via iframe postMessage)
    setStatus("Aguardando dados do Spark...");

    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      const uid = data.userId || data.user_id || data.activeUser?.id;
      const lid = data.locationId || data.location_id || data.activeLocation;

      if (uid && lid) {
        authenticate(uid, COMPANY_ID, lid);
      }
    }

    window.addEventListener("message", handleMessage);

    // 3. Tentar extrair da URL do GHL (o path pode conter o locationId)
    const pathMatch = window.location.href.match(/location\/([a-zA-Z0-9]+)/);
    if (pathMatch) {
      // Se temos o locationId no path mas faltam outros params, aguardar postMessage
      setStatus("Aguardando autenticação...");
    }

    // 4. Timeout - se nao receber dados em 5s, mostrar erro com instrucoes
    const timeout = setTimeout(() => {
      if (!authenticatedRef.current) {
        setError(
          "Não foi possível obter os dados de autenticação. Verifique se a URL do Custom Menu Link está configurada como: " +
          window.location.origin +
          "/?user_id={{user.id}}&location_id={{location.id}}"
        );
      }
    }, 8000);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearTimeout(timeout);
    };
  }, [searchParams, authenticate]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-transparent">
        <div className="text-center max-w-lg px-6">
          <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-4">
            <span className="text-red-600 text-xl font-bold">!</span>
          </div>
          <h1 className="text-lg font-semibold text-gray-900 mb-2">
            Erro de autenticação
          </h1>
          <p className="text-sm text-gray-500 break-words">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent">
      <div className="text-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-500 mx-auto mb-4" />
        <p className="text-sm text-gray-400">{status}</p>
        {IS_DEV_MODE && (
          <button
            type="button"
            onClick={devLogin}
            disabled={devLoading}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-60"
          >
            {devLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            Entrar como dev (location fixa)
          </button>
        )}
      </div>
    </div>
  );
}

export default function SSOEntryPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-transparent">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin text-gray-500 mx-auto mb-4" />
            <p className="text-sm text-gray-400">Carregando...</p>
          </div>
        </div>
      }
    >
      <SSOHandler />
    </Suspense>
  );
}
