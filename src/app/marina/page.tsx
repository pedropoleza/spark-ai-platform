"use client";

/**
 * Marina Lab — página temporária pra Marina Couto testar/treinar o agente de
 * pós-atendimento. Mobile-first, visual de conversa de WhatsApp (é o ambiente
 * em que ela já trabalha o dia inteiro — reduz atrito a zero).
 *
 * 3 modos: Conversar · Sugestão de resposta (print) · Ideias.
 * NADA aqui envia mensagem pra ninguém — ver `_planning/marina-lab/PLANO.md`.
 */
import { useEffect, useRef, useState } from "react";

const AGENT_ID = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";

type Bolha = { de: "eu" | "ia"; texto: string; hora: string };
type Aba = "conversar" | "print" | "ideias";

const agora = () =>
  new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export default function MarinaLab() {
  const [autenticada, setAutenticada] = useState<boolean | null>(null);
  const [senha, setSenha] = useState("");
  const [erroLogin, setErroLogin] = useState("");
  const [entrando, setEntrando] = useState(false);
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
    setEntrando(true);
    try {
      const r = await fetch("/api/marina/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senha }),
      });
      const j = await r.json();
      if (j.ok) setAutenticada(true);
      else setErroLogin(j.erro || "não deu certo");
    } finally {
      setEntrando(false);
    }
  }

  if (autenticada === null) {
    return (
      <div style={S.splash}>
        <div style={S.pulso} />
      </div>
    );
  }

  if (!autenticada) {
    return (
      <div style={S.splash}>
        <form onSubmit={entrar} style={S.cardLogin}>
          <div style={S.avatarGrande}>M</div>
          <h1 style={S.h1}>Oi, Marina!</h1>
          <p style={S.sub}>
            Aqui é onde você testa e ensina a sua IA.
            <br />
            Nada que acontecer nesta tela chega em nenhum cliente.
          </p>
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder="sua senha"
            style={S.inputLogin}
            autoFocus
          />
          {erroLogin && <p style={S.erro}>{erroLogin}</p>}
          <button type="submit" disabled={entrando || !senha} style={S.btnPrimario}>
            {entrando ? "entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    );
  }

  const abas: [Aba, string, string][] = [
    ["conversar", "Conversar", IC.chat],
    ["print", "Sugestão", IC.camera],
    ["ideias", "Ideias", IC.lampada],
  ];

  return (
    <div style={S.pagina}>
      <header style={S.header}>
        <div style={S.avatar}>M</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.tituloTopo}>Sua IA</div>
          <div style={S.subTopo}>
            <span style={S.pontinho} /> modo treino · não envia pra ninguém
          </div>
        </div>
      </header>

      <main style={S.main}>
        {aba === "conversar" && <Conversar />}
        {aba === "print" && <Print />}
        {aba === "ideias" && <Ideias />}
      </main>

      <nav style={S.tabbar}>
        {abas.map(([k, label, icone]) => {
          const ativa = aba === k;
          return (
            <button key={k} onClick={() => setAba(k)} style={S.tab}>
              <span
                style={{ ...S.tabIcone, ...(ativa ? S.tabIconeOn : {}) }}
                dangerouslySetInnerHTML={{ __html: icone }}
              />
              <span style={{ ...S.tabLabel, ...(ativa ? S.tabLabelOn : {}) }}>{label}</span>
            </button>
          );
        })}
      </nav>
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

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth" });
  }, [bolhas, carregando]);

  async function mandar(texto: string) {
    const msg = texto.trim();
    if (!msg || carregando) return;
    setTxt("");
    setBolhas((b) => [...b, { de: "eu", texto: msg, hora: agora() }]);
    setCarregando(true);
    try {
      const r = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: AGENT_ID,
          message: msg,
          execute_actions: false,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      });
      const j = await r.json();
      if (j.session_id) setSessionId(j.session_id);
      const m = j?.response?.message;
      const arr = Array.isArray(m) ? m : m ? [m] : ["(não veio resposta)"];
      setBolhas((b) => [...b, ...arr.map((t: string) => ({ de: "ia" as const, texto: t, hora: agora() }))]);
    } catch {
      setBolhas((b) => [...b, { de: "ia", texto: "(deu erro, tenta de novo)", hora: agora() }]);
    } finally {
      setCarregando(false);
    }
  }

  function recomecar() {
    setBolhas([]);
    setSessionId(null);
  }

  return (
    <>
      <div style={S.chat}>
        <div style={S.aviso}>
          {/* eslint-disable-next-line react/no-danger */}
          <span dangerouslySetInnerHTML={{ __html: IC.cadeado }} />
          Escreva como se fosse a pessoa que participou do seu encontro. Marque 👍 ou 👎 nas
          respostas dela: é assim que ela aprende o seu jeito.
        </div>

        {bolhas.length === 0 && (
          <div style={S.sugestoesIniciais}>
            {[
              "Oi Marina! Seguem minhas respostas: 1) quero mudar de vida, trabalho de diarista há 9 anos 2) porque eu não desisto 3) sim, tenho os 89 4) dar segurança pra minha filha",
              "quanto dá pra ganhar por mês?",
              "posso pagar só semana que vem?",
              "isso aí é um robô falando comigo?",
            ].map((ex) => (
              <button key={ex} style={S.chipSugestao} onClick={() => mandar(ex)}>
                {ex.length > 62 ? ex.slice(0, 62) + "…" : ex}
              </button>
            ))}
          </div>
        )}

        {bolhas.map((b, i) => (
          <div key={i} style={{ ...S.linha, justifyContent: b.de === "eu" ? "flex-end" : "flex-start" }}>
            <div style={{ ...S.bolha, ...(b.de === "eu" ? S.bolhaEu : S.bolhaIa) }}>
              <div>{b.texto}</div>
              <div style={{ ...S.hora, color: b.de === "eu" ? "rgba(0,0,0,.35)" : "#9aa5b1" }}>{b.hora}</div>
              {b.de === "ia" && <Avaliar mensagemIa={b.texto} sessionId={sessionId} />}
            </div>
          </div>
        ))}

        {carregando && (
          <div style={{ ...S.linha, justifyContent: "flex-start" }}>
            <div style={{ ...S.bolha, ...S.bolhaIa, display: "flex", gap: 4, padding: "14px 16px" }}>
              <i style={{ ...S.ponto, animationDelay: "0s" }} />
              <i style={{ ...S.ponto, animationDelay: ".2s" }} />
              <i style={{ ...S.ponto, animationDelay: ".4s" }} />
            </div>
          </div>
        )}
        <div ref={fim} />
      </div>

      {bolhas.length > 0 && (
        <button onClick={recomecar} style={S.btnRecomecar}>
          <span dangerouslySetInnerHTML={{ __html: IC.recomecar }} /> começar outra conversa
        </button>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          mandar(txt);
        }}
        style={S.barra}
      >
        <input
          value={txt}
          onChange={(e) => setTxt(e.target.value)}
          placeholder="escreva como o lead escreveria…"
          style={S.inputBarra}
        />
        <button type="submit" disabled={carregando || !txt.trim()} style={S.btnEnviar}>
          <span dangerouslySetInnerHTML={{ __html: IC.enviar }} />
        </button>
      </form>

      <style>{CSS_GLOBAL}</style>
    </>
  );
}

// ─────────────────────────────────────────────── Avaliar (👍/👎 + sugestão)
function Avaliar({
  mensagemIa,
  sessionId,
  registroId,
}: {
  mensagemIa: string;
  sessionId?: string | null;
  registroId?: string | null;
}) {
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
        tipo: "nota",
        rating,
        mensagem_ia: mensagemIa,
        sugestao_dela: texto || undefined,
        session_id: sessionId || undefined,
        registro_id: registroId || undefined,
      }),
    });
    if (texto) {
      setSalvo(true);
      setAbrindo(false);
    }
  }

  return (
    <div style={S.avaliar}>
      <button
        onClick={() => marcar("positive")}
        style={{ ...S.btnMini, ...(feito === "positive" ? S.btnMiniOk : {}) }}
        aria-label="gostei"
      >
        👍
      </button>
      <button
        onClick={() => {
          marcar("negative");
          setAbrindo(true);
        }}
        style={{ ...S.btnMini, ...(feito === "negative" ? S.btnMiniNao : {}) }}
        aria-label="não gostei"
      >
        👎
      </button>
      <button onClick={() => setAbrindo((v) => !v)} style={S.btnMiniTexto}>
        eu diria assim…
      </button>
      {salvo && <span style={S.okMini}>anotado ✓</span>}
      {abrindo && (
        <div style={{ width: "100%", marginTop: 8 }}>
          <textarea
            value={sugestao}
            onChange={(e) => setSugestao(e.target.value)}
            placeholder="escreve do seu jeito — é exatamente isso que ela vai aprender"
            style={S.textareaMini}
          />
          <button
            onClick={() => marcar(feito || "negative", sugestao)}
            disabled={!sugestao.trim()}
            style={S.btnMiniSalvar}
          >
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
  const [res, setRes] = useState<{
    leitura: string;
    bolhas: string[];
    porque: string;
    confianca: string;
    registro_id: string | null;
  } | null>(null);
  const [erro, setErro] = useState("");
  const [copiado, setCopiado] = useState<number | null>(null);

  function escolher(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 3);
    setErro("");
    setRes(null);
    Promise.all(
      files.map(
        (f) =>
          new Promise<string>((ok, rej) => {
            if (f.size > 5 * 1024 * 1024) return rej(new Error("essa imagem passa de 5MB"));
            const fr = new FileReader();
            fr.onload = () => ok(String(fr.result));
            fr.onerror = () => rej(new Error("não consegui ler o arquivo"));
            fr.readAsDataURL(f);
          }),
      ),
    )
      .then(setImagens)
      .catch((err) => setErro(err.message));
  }

  async function pedir() {
    if (imagens.length === 0 || carregando) return;
    setCarregando(true);
    setErro("");
    setRes(null);
    try {
      const r = await fetch("/api/marina/sugestao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagens, nota }),
      });
      const j = await r.json();
      if (!j.ok) setErro(j.erro || "não deu certo");
      else
        setRes({
          leitura: j.leitura,
          bolhas: j.bolhas,
          porque: j.porque,
          confianca: j.confianca,
          registro_id: j.registro_id,
        });
    } catch {
      setErro("deu erro, tenta de novo");
    } finally {
      setCarregando(false);
    }
  }

  function copiar(texto: string, i: number) {
    navigator.clipboard.writeText(texto);
    setCopiado(i);
    setTimeout(() => setCopiado(null), 1600);
  }

  return (
    <div style={S.painel}>
      <div style={S.aviso}>
        <span dangerouslySetInnerHTML={{ __html: IC.cadeado }} />
        Manda o print da conversa e ela escreve a resposta <b>pra você copiar e mandar</b>. Ela
        não fala com ninguém.
      </div>

      <label style={{ ...S.upload, ...(imagens.length ? S.uploadCheio : {}) }}>
        <input type="file" accept="image/*" multiple onChange={escolher} style={{ display: "none" }} />
        <span style={S.uploadIcone} dangerouslySetInnerHTML={{ __html: IC.cameraGrande }} />
        <span style={{ fontWeight: 600 }}>
          {imagens.length === 0 ? "Escolher print da conversa" : `${imagens.length} print(s) escolhido(s)`}
        </span>
        <span style={S.uploadDica}>{imagens.length === 0 ? "até 3 imagens" : "toque pra trocar"}</span>
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
        placeholder="quer contar algo do contexto? ex: ela já disse que está sem dinheiro (opcional)"
        style={S.textarea}
      />

      <button onClick={pedir} disabled={imagens.length === 0 || carregando} style={S.btnPrimario}>
        {carregando ? "lendo o print…" : "Me sugere a resposta"}
      </button>

      {erro && <p style={S.erro}>{erro}</p>}

      {res && (
        <div style={S.resultado}>
          {res.confianca === "baixa" && (
            <div style={S.alerta}>Não tenho certeza se li o print direito — confere antes de mandar.</div>
          )}

          <div style={S.blocoLeitura}>
            <div style={S.rotulo}>o que eu entendi</div>
            <p style={{ margin: 0, color: "#4b5563", lineHeight: 1.5 }}>{res.leitura}</p>
          </div>

          <div style={S.rotulo}>resposta sugerida · toque pra copiar</div>
          {res.bolhas.map((b, i) => (
            <button key={i} style={S.sugestaoBolha} onClick={() => copiar(b, i)}>
              <span style={{ flex: 1, textAlign: "left" }}>{b}</span>
              <span style={S.copiar}>
                {copiado === i ? "copiado ✓" : <span dangerouslySetInnerHTML={{ __html: IC.copiar }} />}
              </span>
            </button>
          ))}

          <button onClick={() => copiar(res.bolhas.join("\n\n"), -1)} style={S.btnSecundario}>
            {copiado === -1 ? "copiado ✓" : "Copiar tudo"}
          </button>

          {res.porque && <p style={S.porque}>{res.porque}</p>}

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #eef2f7" }}>
            <div style={{ ...S.rotulo, marginBottom: 8 }}>essa resposta ficou boa?</div>
            <Avaliar mensagemIa={res.bolhas.join("\n")} registroId={res.registro_id} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Ideias
function Ideias() {
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
    setTexto("");
    setSalvo(true);
    setTimeout(() => setSalvo(false), 3000);
  }

  return (
    <div style={S.painel}>
      <div style={S.aviso}>
        <span dangerouslySetInnerHTML={{ __html: IC.lampadaPequena }} />
        Seu caderno: o que ela errou, o que ela nunca deveria dizer, uma situação que ela
        precisa saber lidar.
      </div>

      <div style={S.chips}>
        {[
          ["sugestao", "Sugestão"],
          ["cenario", "Situação que acontece"],
          ["nota", "Corrigir um fato"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTipo(k)}
            style={{ ...S.chip, ...(tipo === k ? S.chipOn : {}) }}
          >
            {label}
          </button>
        ))}
      </div>

      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="escreve à vontade…"
        style={{ ...S.textarea, minHeight: 170 }}
      />
      <button onClick={enviar} disabled={!texto.trim()} style={S.btnPrimario}>
        Mandar pro Pedro
      </button>
      {salvo && <p style={S.ok}>recebido, obrigado! ✓</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── ícones (SVG inline)
const sv = (d: string, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" ${extra}>${d}</svg>`;

const IC = {
  chat: sv('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.7A8.4 8.4 0 0 1 3.6 11 8.4 8.4 0 0 1 12 2.6a8.4 8.4 0 0 1 9 8.9z"/>'),
  camera: sv('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  lampada: sv('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  lampadaPequena: sv('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>', 'width="15" height="15"'),
  cadeado: sv('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', 'width="15" height="15"'),
  enviar: sv('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>', 'width="19" height="19"'),
  copiar: sv('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 'width="16" height="16"'),
  recomecar: sv('<path d="M3 2v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 8"/>', 'width="14" height="14"'),
  cameraGrande: sv('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', 'width="26" height="26"'),
};

const CSS_GLOBAL = `
@keyframes pulsinho { 0%,60%,100%{transform:translateY(0);opacity:.4} 30%{transform:translateY(-4px);opacity:1} }
@keyframes girar { to { transform: rotate(360deg) } }
* { -webkit-tap-highlight-color: transparent; }
textarea:focus, input:focus { border-color:#0f9d76 !important; }
`;

// ─────────────────────────────────────────────────────────── estilos
const VERDE = "#0f9d76";
const VERDE_ESCURO = "#0b7d5e";
const FUNDO_CHAT = "#eae6df";

const S: Record<string, React.CSSProperties> = {
  splash: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${VERDE_ESCURO} 0%, #0a5f48 100%)`, padding: 22, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  pulso: { width: 42, height: 42, borderRadius: "50%", border: "3px solid rgba(255,255,255,.25)", borderTopColor: "#fff", animation: "girar .8s linear infinite" },
  cardLogin: { background: "#fff", padding: "34px 26px 28px", borderRadius: 26, boxShadow: "0 18px 50px rgba(0,0,0,.22)", width: "100%", maxWidth: 350, textAlign: "center" },
  avatarGrande: { width: 62, height: 62, borderRadius: "50%", background: `linear-gradient(140deg, ${VERDE} 0%, ${VERDE_ESCURO} 100%)`, color: "#fff", fontSize: 26, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" },
  h1: { fontSize: 23, margin: "0 0 8px", color: "#111b21", fontWeight: 600 },
  sub: { fontSize: 14.5, color: "#667781", margin: "0 0 22px", lineHeight: 1.55 },
  inputLogin: { width: "100%", padding: "15px 16px", fontSize: 16, borderRadius: 16, border: "1.5px solid #e4e8eb", outline: "none", marginBottom: 12, boxSizing: "border-box", background: "#f7f9fa" },

  pagina: { height: "100dvh", background: FUNDO_CHAT, display: "flex", flexDirection: "column", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", background: VERDE_ESCURO, color: "#fff", flexShrink: 0 },
  avatar: { width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 600, flexShrink: 0 },
  tituloTopo: { fontSize: 16.5, fontWeight: 600 },
  subTopo: { fontSize: 12, opacity: .82, display: "flex", alignItems: "center", gap: 5 },
  pontinho: { width: 7, height: 7, borderRadius: "50%", background: "#7ee2b8", display: "inline-block" },

  main: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
  chat: { flex: 1, overflowY: "auto", padding: "14px 12px 4px", WebkitOverflowScrolling: "touch" },
  aviso: { display: "flex", alignItems: "flex-start", gap: 8, margin: "0 auto 14px", padding: "10px 13px", background: "#fff7e0", borderRadius: 14, fontSize: 12.8, color: "#7a6320", lineHeight: 1.5, maxWidth: 520 },

  sugestoesIniciais: { display: "flex", flexDirection: "column", gap: 9, marginTop: 6 },
  chipSugestao: { padding: "13px 15px", borderRadius: 18, border: "none", background: "#fff", color: "#3b4a54", fontSize: 14.5, textAlign: "left", cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,.08)", lineHeight: 1.45 },

  linha: { display: "flex", marginBottom: 9 },
  bolha: { maxWidth: "88%", padding: "9px 12px 7px", borderRadius: 16, fontSize: 15.2, lineHeight: 1.47, whiteSpace: "pre-wrap", wordBreak: "break-word", boxShadow: "0 1px 1px rgba(0,0,0,.09)" },
  bolhaEu: { background: "#d9fdd3", color: "#111b21", borderTopRightRadius: 5 },
  bolhaIa: { background: "#fff", color: "#111b21", borderTopLeftRadius: 5 },
  hora: { fontSize: 10.5, textAlign: "right", marginTop: 3 },
  ponto: { width: 7, height: 7, borderRadius: "50%", background: "#9aa5b1", display: "inline-block", animation: "pulsinho 1.2s infinite" },

  avaliar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginTop: 8, paddingTop: 8, borderTop: "1px solid #f0f2f5" },
  btnMini: { border: "1.5px solid #e9edf0", background: "#fff", borderRadius: 11, padding: "4px 10px", cursor: "pointer", fontSize: 15, lineHeight: 1.2 },
  btnMiniOk: { background: "#e7f8f0", borderColor: VERDE },
  btnMiniNao: { background: "#fdeeee", borderColor: "#e88" },
  btnMiniTexto: { border: "none", background: "none", color: VERDE, fontSize: 12.5, cursor: "pointer", padding: 0, fontWeight: 600 },
  btnMiniSalvar: { marginTop: 7, padding: "8px 16px", borderRadius: 11, border: "none", background: VERDE, color: "#fff", fontSize: 13.5, cursor: "pointer", fontWeight: 600 },
  textareaMini: { width: "100%", minHeight: 64, padding: 11, borderRadius: 13, border: "1.5px solid #e4e8eb", fontSize: 14.5, boxSizing: "border-box", fontFamily: "inherit", outline: "none", background: "#f7f9fa" },
  okMini: { fontSize: 12, color: VERDE, fontWeight: 600 },

  btnRecomecar: { alignSelf: "center", display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px", padding: "7px 15px", borderRadius: 20, border: "none", background: "rgba(255,255,255,.75)", color: "#667781", fontSize: 12.5, cursor: "pointer" },
  barra: { display: "flex", gap: 8, padding: "10px 12px", background: "#f0f2f5", alignItems: "center", flexShrink: 0 },
  inputBarra: { flex: 1, padding: "13px 17px", fontSize: 16, borderRadius: 24, border: "none", outline: "none", background: "#fff", boxShadow: "0 1px 1px rgba(0,0,0,.06)" },
  btnEnviar: { width: 48, height: 48, borderRadius: "50%", border: "none", background: VERDE, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },

  tabbar: { display: "flex", background: "#fff", borderTop: "1px solid #e9edf0", paddingBottom: "env(safe-area-inset-bottom)", flexShrink: 0 },
  tab: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 4px 8px", border: "none", background: "none", cursor: "pointer" },
  tabIcone: { color: "#8696a0", display: "flex" },
  tabIconeOn: { color: VERDE },
  tabLabel: { fontSize: 11.5, color: "#8696a0" },
  tabLabelOn: { color: VERDE, fontWeight: 600 },

  painel: { flex: 1, overflowY: "auto", padding: "14px 14px 26px", WebkitOverflowScrolling: "touch" },
  upload: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "26px 16px", borderRadius: 20, border: `2px dashed #c8d3da`, background: "#fff", textAlign: "center", color: "#3b4a54", fontSize: 15, cursor: "pointer" },
  uploadCheio: { borderColor: VERDE, background: "#f2fbf7" },
  uploadIcone: { color: VERDE, display: "flex" },
  uploadDica: { fontSize: 12.5, color: "#8696a0" },
  miniaturas: { display: "flex", gap: 8, marginTop: 11, flexWrap: "wrap" },
  miniatura: { width: 78, height: 78, objectFit: "cover", borderRadius: 14, border: "2px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,.14)" },
  textarea: { width: "100%", minHeight: 78, padding: 13, marginTop: 11, borderRadius: 16, border: "1.5px solid #e4e8eb", fontSize: 15.5, boxSizing: "border-box", fontFamily: "inherit", outline: "none", background: "#fff" },

  btnPrimario: { width: "100%", padding: "15px", marginTop: 11, borderRadius: 16, border: "none", background: VERDE, color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer", boxShadow: "0 3px 10px rgba(15,157,118,.28)" },
  btnSecundario: { width: "100%", padding: "12px", marginTop: 9, borderRadius: 13, border: `1.5px solid ${VERDE}`, background: "#fff", color: VERDE_ESCURO, fontSize: 14.5, cursor: "pointer", fontWeight: 600 },

  resultado: { marginTop: 16, padding: 15, background: "#fff", borderRadius: 20, boxShadow: "0 2px 10px rgba(0,0,0,.07)" },
  alerta: { padding: "10px 12px", background: "#fff7e0", borderRadius: 12, fontSize: 13, color: "#7a6320", marginBottom: 12, lineHeight: 1.45 },
  blocoLeitura: { padding: "12px 13px", background: "#f7f9fa", borderRadius: 14, fontSize: 14, marginBottom: 14 },
  rotulo: { fontSize: 11.5, textTransform: "uppercase", letterSpacing: .5, color: "#8696a0", marginBottom: 7, fontWeight: 700 },
  sugestaoBolha: { display: "flex", alignItems: "flex-start", gap: 10, width: "100%", padding: "13px 14px", marginBottom: 9, background: "#d9fdd3", border: "none", borderRadius: 16, borderTopLeftRadius: 5, fontSize: 15.2, lineHeight: 1.47, cursor: "pointer", whiteSpace: "pre-wrap", color: "#111b21", fontFamily: "inherit", textAlign: "left" },
  copiar: { fontSize: 11.5, color: VERDE_ESCURO, whiteSpace: "nowrap", fontWeight: 700, display: "flex", alignItems: "center" },
  porque: { fontSize: 13.5, color: "#667781", marginTop: 12, lineHeight: 1.5, paddingLeft: 11, borderLeft: `3px solid ${VERDE}` },

  chips: { display: "flex", gap: 7, marginTop: 13, flexWrap: "wrap" },
  chip: { padding: "9px 14px", borderRadius: 22, border: "1.5px solid #e4e8eb", background: "#fff", fontSize: 13.5, color: "#667781", cursor: "pointer" },
  chipOn: { background: "#e7f8f0", borderColor: VERDE, color: VERDE_ESCURO, fontWeight: 600 },

  erro: { color: "#c0392b", fontSize: 13.5, marginTop: 10, textAlign: "center" },
  ok: { color: VERDE, fontSize: 14.5, marginTop: 12, textAlign: "center", fontWeight: 600 },
};
