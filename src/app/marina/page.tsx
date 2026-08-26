"use client";

/**
 * Marina Lab — página temporária pra Marina Couto testar/treinar o agente de
 * pós-atendimento. Mobile-first (ela usa do celular).
 *
 * 3 modos: Conversar · Sugestão de resposta (print) · Sugestões.
 * NADA aqui envia mensagem pra ninguém — ver `_planning/marina-lab/PLANO.md`.
 */
import { useEffect, useRef, useState } from "react";

const AGENT_ID = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";

type Bolha = { de: "eu" | "ia"; texto: string };
type Aba = "conversar" | "print" | "sugestoes";

export default function MarinaLab() {
  const [autenticada, setAutenticada] = useState<boolean | null>(null);
  const [senha, setSenha] = useState("");
  const [erroLogin, setErroLogin] = useState("");
  const [aba, setAba] = useState<Aba>("conversar");

  useEffect(() => {
    fetch("/api/marina/auth")
      .then((r) => r.json())
      .then((j) => setAutenticada(!!j.autenticada))
      .catch(() => setAutenticada(false));
  }, []);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setErroLogin("");
    const r = await fetch("/api/marina/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senha }),
    });
    const j = await r.json();
    if (j.ok) setAutenticada(true);
    else setErroLogin(j.erro || "não deu certo");
  }

  if (autenticada === null) {
    return <div style={S.centro}><p style={{ color: "#64748b" }}>carregando…</p></div>;
  }

  if (!autenticada) {
    return (
      <div style={S.centro}>
        <form onSubmit={entrar} style={S.cardLogin}>
          <div style={{ fontSize: 34, marginBottom: 6 }}>✨</div>
          <h1 style={S.h1}>Oi, Marina!</h1>
          <p style={S.sub}>Esse é o espaço pra você testar e ensinar a sua IA.</p>
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="senha"
            style={S.input}
            autoFocus
          />
          {erroLogin && <p style={S.erro}>{erroLogin}</p>}
          <button type="submit" style={S.btnPrimario}>Entrar</button>
        </form>
      </div>
    );
  }

  return (
    <div style={S.pagina}>
      <header style={S.header}>
        <div>
          <div style={S.tituloTopo}>Sua IA · laboratório</div>
          <div style={S.subTopo}>nada aqui é enviado pra ninguém</div>
        </div>
      </header>

      <nav style={S.abas}>
        {([
          ["conversar", "💬 Conversar"],
          ["print", "📸 Sugestão"],
          ["sugestoes", "💡 Ideias"],
        ] as [Aba, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setAba(k)}
            style={{ ...S.aba, ...(aba === k ? S.abaAtiva : {}) }}
          >
            {label}
          </button>
        ))}
      </nav>

      <main style={S.main}>
        {aba === "conversar" && <Conversar />}
        {aba === "print" && <Print />}
        {aba === "sugestoes" && <Sugestoes />}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Conversar
function Conversar() {
  const [bolhas, setBolhas] = useState<Bolha[]>([]);
  const [txt, setTxt] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => { fim.current?.scrollIntoView({ behavior: "smooth" }); }, [bolhas, carregando]);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const msg = txt.trim();
    if (!msg || carregando) return;
    setTxt("");
    setBolhas((b) => [...b, { de: "eu", texto: msg }]);
    setCarregando(true);
    try {
      const r = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: AGENT_ID, message: msg, execute_actions: false, ...(sessionId ? { session_id: sessionId } : {}) }),
      });
      const j = await r.json();
      if (j.session_id) setSessionId(j.session_id);
      const m = j?.response?.message;
      const arr = Array.isArray(m) ? m : m ? [m] : ["(não veio resposta)"];
      setBolhas((b) => [...b, ...arr.map((t: string) => ({ de: "ia" as const, texto: t }))]);
    } catch {
      setBolhas((b) => [...b, { de: "ia", texto: "(deu erro, tenta de novo)" }]);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <>
      <div style={S.dica}>
        Escreva como se fosse uma pessoa que participou do seu encontro. Nas respostas da IA,
        use 👍 / 👎 — o que você marcar entra no aprendizado dela.
      </div>

      <div style={S.chat}>
        {bolhas.length === 0 && (
          <div style={S.vazio}>
            <p style={{ margin: 0 }}>Comece por aqui 👇</p>
            <div style={S.exemplos}>
              {[
                "Oi Marina! Seguem minhas respostas: 1) quero mudar de vida...",
                "quanto dá pra ganhar por mês?",
                "posso pagar semana que vem?",
                "isso aí é robô?",
              ].map((ex) => (
                <button key={ex} style={S.exemplo} onClick={() => setTxt(ex)}>{ex}</button>
              ))}
            </div>
          </div>
        )}
        {bolhas.map((b, i) => (
          <div key={i} style={{ ...S.linha, justifyContent: b.de === "eu" ? "flex-end" : "flex-start" }}>
            <div style={{ ...S.bolha, ...(b.de === "eu" ? S.bolhaEu : S.bolhaIa) }}>
              {b.texto}
              {b.de === "ia" && <Avaliar mensagemIa={b.texto} sessionId={sessionId} />}
            </div>
          </div>
        ))}
        {carregando && <div style={{ ...S.linha, justifyContent: "flex-start" }}><div style={{ ...S.bolha, ...S.bolhaIa, color: "#94a3b8" }}>escrevendo…</div></div>}
        <div ref={fim} />
      </div>

      <form onSubmit={enviar} style={S.barra}>
        <input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="escreva como o lead escreveria…" style={S.inputBarra} />
        <button type="submit" disabled={carregando} style={S.btnEnviar}>➤</button>
      </form>
    </>
  );
}

// ─────────────────────────────────────────────── Avaliar (👍/👎 + sugestão)
function Avaliar({ mensagemIa, sessionId, registroId }: { mensagemIa: string; sessionId?: string | null; registroId?: string | null }) {
  const [feito, setFeito] = useState<"positive" | "negative" | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  const [sugestao, setSugestao] = useState("");
  const [salvo, setSalvo] = useState(false);

  async function marcar(rating: "positive" | "negative", texto?: string) {
    setFeito(rating);
    await fetch("/api/marina/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tipo: "nota", rating, mensagem_ia: mensagemIa,
        sugestao_dela: texto || undefined,
        session_id: sessionId || undefined,
        registro_id: registroId || undefined,
      }),
    });
    if (texto) { setSalvo(true); setAbrindo(false); }
  }

  return (
    <div style={S.avaliar}>
      <button onClick={() => marcar("positive")} style={{ ...S.btnMini, ...(feito === "positive" ? S.btnMiniOn : {}) }}>👍</button>
      <button onClick={() => { setFeito("negative"); setAbrindo(true); marcar("negative"); }} style={{ ...S.btnMini, ...(feito === "negative" ? S.btnMiniOn : {}) }}>👎</button>
      <button onClick={() => setAbrindo((v) => !v)} style={S.btnMiniTexto}>eu diria assim…</button>
      {salvo && <span style={S.okMini}>anotado ✓</span>}
      {abrindo && (
        <div style={{ width: "100%", marginTop: 6 }}>
          <textarea
            value={sugestao}
            onChange={(e) => setSugestao(e.target.value)}
            placeholder="escreve do seu jeito — é isso que ela vai aprender"
            style={S.textareaMini}
          />
          <button onClick={() => marcar(feito || "negative", sugestao)} disabled={!sugestao.trim()} style={S.btnMiniSalvar}>
            Salvar
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Print
function Print() {
  const [imagens, setImagens] = useState<string[]>([]);
  const [nota, setNota] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [res, setRes] = useState<{ leitura: string; bolhas: string[]; porque: string; confianca: string; registro_id: string | null } | null>(null);
  const [erro, setErro] = useState("");
  const [copiado, setCopiado] = useState<number | null>(null);

  function escolher(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 3);
    setErro("");
    Promise.all(
      files.map(
        (f) =>
          new Promise<string>((res2, rej) => {
            if (f.size > 5 * 1024 * 1024) return rej(new Error("imagem maior que 5MB"));
            const fr = new FileReader();
            fr.onload = () => res2(String(fr.result));
            fr.onerror = () => rej(new Error("não consegui ler o arquivo"));
            fr.readAsDataURL(f);
          }),
      ),
    ).then(setImagens).catch((err) => setErro(err.message));
  }

  async function pedir() {
    if (imagens.length === 0 || carregando) return;
    setCarregando(true); setErro(""); setRes(null);
    try {
      const r = await fetch("/api/marina/sugestao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagens, nota }),
      });
      const j = await r.json();
      if (!j.ok) setErro(j.erro || "não deu certo");
      else setRes({ leitura: j.leitura, bolhas: j.bolhas, porque: j.porque, confianca: j.confianca, registro_id: j.registro_id });
    } catch {
      setErro("deu erro, tenta de novo");
    } finally {
      setCarregando(false);
    }
  }

  function copiar(texto: string, i: number) {
    navigator.clipboard.writeText(texto);
    setCopiado(i);
    setTimeout(() => setCopiado(null), 1500);
  }

  return (
    <div style={S.painel}>
      <div style={S.dica}>
        Manda o print da conversa com a pessoa. A IA lê e escreve a resposta <b>pra você copiar
        e mandar</b> — ela não fala com ninguém.
      </div>

      <label style={S.upload}>
        <input type="file" accept="image/*" multiple onChange={escolher} style={{ display: "none" }} />
        {imagens.length === 0 ? "📸  Escolher print (até 3)" : `${imagens.length} print(s) escolhido(s) — trocar`}
      </label>

      {imagens.length > 0 && (
        <div style={S.miniaturas}>
          {imagens.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt={`print ${i + 1}`} style={S.miniatura} />
          ))}
        </div>
      )}

      <textarea
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        placeholder="quer contar algo do contexto? (opcional) ex: ela já disse que tá sem dinheiro"
        style={S.textarea}
      />

      <button onClick={pedir} disabled={imagens.length === 0 || carregando} style={S.btnPrimario}>
        {carregando ? "lendo o print…" : "Me sugere a resposta"}
      </button>

      {erro && <p style={S.erro}>{erro}</p>}

      {res && (
        <div style={S.resultado}>
          {res.confianca === "baixa" && (
            <div style={S.alerta}>⚠️ Não tenho certeza de que li o print direito — confere antes de mandar.</div>
          )}
          <div style={S.blocoLeitura}>
            <div style={S.rotulo}>O que eu entendi</div>
            <p style={{ margin: 0, color: "#475569" }}>{res.leitura}</p>
          </div>

          <div style={S.rotulo}>Resposta sugerida — toque pra copiar</div>
          {res.bolhas.map((b, i) => (
            <div key={i} style={S.sugestaoBolha} onClick={() => copiar(b, i)}>
              <span style={{ flex: 1 }}>{b}</span>
              <span style={S.copiar}>{copiado === i ? "copiado ✓" : "copiar"}</span>
            </div>
          ))}
          <button onClick={() => copiar(res.bolhas.join("\n\n"), -1)} style={S.btnSecundario}>
            {copiado === -1 ? "copiado ✓" : "Copiar tudo"}
          </button>

          {res.porque && <p style={S.porque}>💭 {res.porque}</p>}

          <div style={{ marginTop: 10 }}>
            <Avaliar mensagemIa={res.bolhas.join("\n")} registroId={res.registro_id} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Sugestões
function Sugestoes() {
  const [texto, setTexto] = useState("");
  const [tipo, setTipo] = useState("sugestao");
  const [salvo, setSalvo] = useState(false);

  async function enviar() {
    if (!texto.trim()) return;
    await fetch("/api/marina/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo, texto }),
    });
    setTexto(""); setSalvo(true);
    setTimeout(() => setSalvo(false), 2500);
  }

  return (
    <div style={S.painel}>
      <div style={S.dica}>
        Aqui é o seu caderno: o que a IA errou, o que ela nunca deveria dizer, uma situação que
        ela precisa saber lidar, um fato que faltou.
      </div>

      <div style={S.chips}>
        {[
          ["sugestao", "💡 Sugestão"],
          ["cenario", "🎬 Uma situação que acontece"],
          ["nota", "📝 Correção de fato"],
        ].map(([k, label]) => (
          <button key={k} onClick={() => setTipo(k)} style={{ ...S.chip, ...(tipo === k ? S.chipOn : {}) }}>
            {label}
          </button>
        ))}
      </div>

      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="escreve à vontade…"
        style={{ ...S.textarea, minHeight: 160 }}
      />
      <button onClick={enviar} disabled={!texto.trim()} style={S.btnPrimario}>Mandar pro Pedro</button>
      {salvo && <p style={S.ok}>recebido ✓ obrigado!</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── estilos
const S: Record<string, React.CSSProperties> = {
  pagina: { minHeight: "100dvh", background: "#f8fafc", display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  centro: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", padding: 20, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif" },
  cardLogin: { background: "#fff", padding: 28, borderRadius: 20, boxShadow: "0 4px 24px rgba(15,23,42,.08)", width: "100%", maxWidth: 340, textAlign: "center" },
  h1: { fontSize: 22, margin: "0 0 6px", color: "#0f172a" },
  sub: { fontSize: 14, color: "#64748b", margin: "0 0 18px" },
  input: { width: "100%", padding: "13px 14px", fontSize: 16, borderRadius: 12, border: "1px solid #e2e8f0", outline: "none", marginBottom: 10, boxSizing: "border-box" },
  header: { padding: "14px 16px 10px", background: "#fff", borderBottom: "1px solid #eef2f7" },
  tituloTopo: { fontSize: 16, fontWeight: 600, color: "#0f172a" },
  subTopo: { fontSize: 12, color: "#94a3b8" },
  abas: { display: "flex", gap: 6, padding: "10px 12px", background: "#fff", borderBottom: "1px solid #eef2f7", position: "sticky", top: 0, zIndex: 5 },
  aba: { flex: 1, padding: "9px 6px", fontSize: 13, borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", cursor: "pointer" },
  abaAtiva: { background: "#7c3aed", color: "#fff", borderColor: "#7c3aed", fontWeight: 600 },
  main: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  dica: { margin: "12px 14px 6px", padding: "10px 12px", background: "#f1f5f9", borderRadius: 12, fontSize: 13, color: "#475569", lineHeight: 1.45 },
  chat: { flex: 1, overflowY: "auto", padding: "8px 12px 12px" },
  vazio: { textAlign: "center", color: "#94a3b8", fontSize: 14, marginTop: 24 },
  exemplos: { display: "flex", flexDirection: "column", gap: 8, marginTop: 14 },
  exemplo: { padding: "10px 12px", borderRadius: 12, border: "1px dashed #cbd5e1", background: "#fff", color: "#475569", fontSize: 13, textAlign: "left", cursor: "pointer" },
  linha: { display: "flex", marginBottom: 8 },
  bolha: { maxWidth: "85%", padding: "10px 13px", borderRadius: 16, fontSize: 15, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bolhaEu: { background: "#7c3aed", color: "#fff", borderBottomRightRadius: 5 },
  bolhaIa: { background: "#fff", color: "#0f172a", border: "1px solid #e9eef5", borderBottomLeftRadius: 5 },
  avaliar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8, paddingTop: 7, borderTop: "1px solid #f1f5f9" },
  btnMini: { border: "1px solid #e2e8f0", background: "#fff", borderRadius: 8, padding: "3px 8px", cursor: "pointer", fontSize: 14 },
  btnMiniOn: { background: "#ede9fe", borderColor: "#c4b5fd" },
  btnMiniTexto: { border: "none", background: "none", color: "#7c3aed", fontSize: 12, cursor: "pointer", padding: 0 },
  btnMiniSalvar: { marginTop: 6, padding: "6px 12px", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontSize: 13, cursor: "pointer" },
  textareaMini: { width: "100%", minHeight: 60, padding: 9, borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" },
  okMini: { fontSize: 12, color: "#059669" },
  barra: { display: "flex", gap: 8, padding: 12, background: "#fff", borderTop: "1px solid #eef2f7" },
  inputBarra: { flex: 1, padding: "12px 14px", fontSize: 16, borderRadius: 22, border: "1px solid #e2e8f0", outline: "none" },
  btnEnviar: { width: 46, height: 46, borderRadius: "50%", border: "none", background: "#7c3aed", color: "#fff", fontSize: 18, cursor: "pointer" },
  painel: { padding: "0 14px 24px", overflowY: "auto" },
  upload: { display: "block", padding: "16px", marginTop: 10, borderRadius: 14, border: "2px dashed #cbd5e1", background: "#fff", textAlign: "center", color: "#475569", fontSize: 15, cursor: "pointer" },
  miniaturas: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
  miniatura: { width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: "1px solid #e2e8f0" },
  textarea: { width: "100%", minHeight: 74, padding: 12, marginTop: 10, borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 15, boxSizing: "border-box", fontFamily: "inherit" },
  btnPrimario: { width: "100%", padding: "14px", marginTop: 10, borderRadius: 12, border: "none", background: "#7c3aed", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" },
  btnSecundario: { width: "100%", padding: "11px", marginTop: 8, borderRadius: 10, border: "1px solid #ddd6fe", background: "#f5f3ff", color: "#6d28d9", fontSize: 14, cursor: "pointer" },
  resultado: { marginTop: 16, padding: 14, background: "#fff", borderRadius: 14, border: "1px solid #e9eef5" },
  alerta: { padding: "9px 11px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, fontSize: 13, color: "#92400e", marginBottom: 10 },
  blocoLeitura: { padding: "10px 12px", background: "#f8fafc", borderRadius: 10, fontSize: 14, marginBottom: 12 },
  rotulo: { fontSize: 12, textTransform: "uppercase", letterSpacing: .4, color: "#94a3b8", marginBottom: 6, fontWeight: 600 },
  sugestaoBolha: { display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 13px", marginBottom: 8, background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 14, fontSize: 15, lineHeight: 1.45, cursor: "pointer", whiteSpace: "pre-wrap" },
  copiar: { fontSize: 11, color: "#7c3aed", whiteSpace: "nowrap", fontWeight: 600 },
  porque: { fontSize: 13, color: "#64748b", marginTop: 10, fontStyle: "italic" },
  chips: { display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" },
  chip: { padding: "7px 11px", borderRadius: 20, border: "1px solid #e2e8f0", background: "#fff", fontSize: 13, color: "#64748b", cursor: "pointer" },
  chipOn: { background: "#ede9fe", borderColor: "#c4b5fd", color: "#6d28d9", fontWeight: 600 },
  erro: { color: "#dc2626", fontSize: 13, marginTop: 8 },
  ok: { color: "#059669", fontSize: 14, marginTop: 10, textAlign: "center" },
};
