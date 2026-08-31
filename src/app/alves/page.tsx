"use client";

/**
 * Alves Lab — página temporária pro time da Alves Cury (Marcos) testar a Bruna
 * e o Bruno reformados ANTES da religa (pedido do Pedro 2026-08-31, pós-H88).
 *
 * Mesmo desenho do Marina Lab: PIN → cookie, chat pelo endpoint de teste
 * (NADA envia pra lead), 👍/👎 alimentando agent_feedback (entra no prompt no
 * turno seguinte). Extras deste lab:
 *  - botão "E se o lead sumisse agora?" → preview REAL dos 3 toques de
 *    follow-up (mesmo gerador + guards de produção);
 *  - aba "Melhorias" — cada reclamação do Marcos → o que mudou (a moral);
 *  - chips de provocação com as perguntas difíceis da bateria de teste.
 */
import { useEffect, useRef, useState } from "react";

const BRUNA = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
const BRUNO = "a0339877-7096-4384-a2d8-34d9daedb339";

type AgenteKey = "bruna" | "bruno";
const AGENTES: Record<AgenteKey, { id: string; nome: string; papel: string; cor: string; inicial: string }> = {
  bruna: { id: BRUNA, nome: "Bruna", papel: "seguro de vida", cor: "#0e7a5f", inicial: "B" },
  bruno: { id: BRUNO, nome: "Bruno", papel: "recrutamento", cor: "#1d4ed8", inicial: "B" },
};

const CHIPS_INICIAIS: Record<AgenteKey, string[]> = {
  bruna: [
    "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida",
    "quanto custa o seguro de voces",
    "isso eh golpe? tem muito golpe por ai",
    "Hola, vivo en Estados Unidos y quisiera información sobre el seguro de vida",
    "vi que voces tem aquela parte de trabalhar com voces tambem ne? como funciona?",
  ],
  bruno: [
    "Moro nos EUA e gostaria de mais informações de como me tornar agente financeiro",
    "quanto da pra ganhar por mes?",
    "nao tenho work permit ainda, ta em processo",
    "tem como ser amanha? to com pressa",
    "isso ai eh piramide?",
  ],
};

const CHIPS_MEIO: Record<AgenteKey, string[]> = {
  bruna: ["vou pensar", "me manda por escrito", "ta bom vai... mas é ligação hein, nada de zoom", "é robô falando comigo?", "me da uma faixa de preço pelo menos"],
  bruno: ["precisa de ingles?", "nao tenho experiencia nenhuma", "quanto custa pra tirar a licença?", "é robô falando comigo?", "so posso de manha"],
};

type Bolha = { de: "eu" | "ia"; texto: string; hora: string };
type Aba = "conversar" | "melhorias" | "ideias";
type Toque = { n: number; quando: string; texto?: string; quieto?: boolean; motivo?: string };

const agora = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export default function AlvesLab() {
  const [autenticado, setAutenticado] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [erroLogin, setErroLogin] = useState("");
  const [entrando, setEntrando] = useState(false);
  const [aba, setAba] = useState<Aba>("conversar");
  const [agente, setAgente] = useState<AgenteKey>("bruna");

  useEffect(() => {
    fetch("/api/alves/auth")
      .then((r) => r.json())
      .then((j) => setAutenticado(!!j.autenticado))
      .catch(() => setAutenticado(false));
  }, []);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setErroLogin("");
    setEntrando(true);
    try {
      const r = await fetch("/api/alves/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const j = await r.json();
      if (j.ok) setAutenticado(true);
      else setErroLogin(j.erro || "não deu certo");
    } finally {
      setEntrando(false);
    }
  }

  if (autenticado === null) {
    return (
      <div style={S.splash}>
        <div style={S.pulso} />
        <style>{CSS_GLOBAL}</style>
      </div>
    );
  }

  if (!autenticado) {
    return (
      <div style={S.splash}>
        <form onSubmit={entrar} style={S.cardLogin}>
          <div style={S.logoLogin}>AC</div>
          <h1 style={S.h1}>Alves Cury · Lab da IA</h1>
          <p style={S.sub}>
            Aqui vocês testam a Bruna e o Bruno reformados.
            <br />
            Nada desta tela chega em nenhum cliente.
          </p>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="PIN de 4 dígitos"
            style={S.inputPin}
            autoFocus
          />
          {erroLogin && <p style={S.erro}>{erroLogin}</p>}
          <button type="submit" disabled={entrando || pin.length !== 4} style={S.btnPrimario}>
            {entrando ? "entrando…" : "Entrar"}
          </button>
        </form>
        <style>{CSS_GLOBAL}</style>
      </div>
    );
  }

  const A = AGENTES[agente];
  const abas: [Aba, string][] = [
    ["conversar", "💬 Conversar"],
    ["melhorias", "✅ Melhorias"],
    ["ideias", "💡 Ideias"],
  ];

  return (
    <div style={S.pagina}>
      <header style={{ ...S.header, background: A.cor }}>
        <div style={S.avatar}>{A.inicial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.tituloTopo}>
            {A.nome} · {A.papel}
          </div>
          <div style={S.subTopo}>
            <span style={S.pontinho} /> modo teste · não envia pra ninguém
          </div>
        </div>
        <div style={S.switchAgente}>
          {(Object.keys(AGENTES) as AgenteKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setAgente(k)}
              style={{ ...S.switchBtn, ...(agente === k ? S.switchBtnOn : {}) }}
            >
              {AGENTES[k].nome}
            </button>
          ))}
        </div>
      </header>

      <main style={S.main}>
        {aba === "conversar" && <Conversar key={agente} agente={agente} />}
        {aba === "melhorias" && <Melhorias />}
        {aba === "ideias" && <Ideias agente={agente} />}
      </main>

      <nav style={S.tabbar}>
        {abas.map(([k, label]) => (
          <button key={k} onClick={() => setAba(k)} style={{ ...S.tab, ...(aba === k ? S.tabOn : {}) }}>
            {label}
          </button>
        ))}
      </nav>
      <style>{CSS_GLOBAL}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Conversar
function Conversar({ agente }: { agente: AgenteKey }) {
  const A = AGENTES[agente];
  const [bolhas, setBolhas] = useState<Bolha[]>([]);
  const [txt, setTxt] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chipsAbertos, setChipsAbertos] = useState(false);
  const [fu, setFu] = useState<{ aberto: boolean; carregando: boolean; toques: Toque[]; nota?: string; erro?: string }>({
    aberto: false,
    carregando: false,
    toques: [],
  });
  const fim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth" });
  }, [bolhas, carregando, fu.aberto]);

  async function mandar(texto: string) {
    const msg = texto.trim();
    if (!msg || carregando) return;
    setTxt("");
    setChipsAbertos(false);
    setBolhas((b) => [...b, { de: "eu", texto: msg, hora: agora() }]);
    setCarregando(true);
    try {
      const r = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: A.id,
          message: msg,
          execute_actions: false,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      });
      const j = await r.json();
      if (j.session_id) setSessionId(j.session_id);
      const m = j?.response?.message;
      const arr = Array.isArray(m) ? m : m ? [m] : ["(não veio resposta — tenta de novo)"];
      setBolhas((b) => [...b, ...arr.map((t: string) => ({ de: "ia" as const, texto: t, hora: agora() }))]);
    } catch {
      setBolhas((b) => [...b, { de: "ia", texto: "(deu erro, tenta de novo)", hora: agora() }]);
    } finally {
      setCarregando(false);
    }
  }

  async function verFollowUps() {
    if (!sessionId || fu.carregando) return;
    setFu({ aberto: true, carregando: true, toques: [] });
    try {
      const r = await fetch("/api/alves/followup-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: A.id, session_id: sessionId }),
      });
      const j = await r.json();
      if (j.ok) setFu({ aberto: true, carregando: false, toques: j.toques || [], nota: j.nota });
      else setFu({ aberto: true, carregando: false, toques: [], erro: j.erro || "não deu certo" });
    } catch {
      setFu({ aberto: true, carregando: false, toques: [], erro: "deu erro, tenta de novo" });
    }
  }

  function recomecar() {
    setBolhas([]);
    setSessionId(null);
    setFu({ aberto: false, carregando: false, toques: [] });
  }

  const temConversa = bolhas.some((b) => b.de === "ia");

  return (
    <>
      <div style={S.chat}>
        <div style={S.aviso}>
          Escreva como se fosse um lead que chegou pelo anúncio. Marque 👍 ou 👎 nas respostas —
          o feedback de vocês entra no comportamento {agente === "bruna" ? "da Bruna" : "do Bruno"} na hora.
        </div>

        {bolhas.length === 0 && (
          <div style={S.sugestoesIniciais}>
            <div style={S.chipsTitulo}>toca pra começar com uma dessas:</div>
            {CHIPS_INICIAIS[agente].map((ex) => (
              <button key={ex} style={S.chipSugestao} onClick={() => mandar(ex)}>
                {ex.length > 64 ? ex.slice(0, 64) + "…" : ex}
              </button>
            ))}
          </div>
        )}

        {bolhas.map((b, i) => (
          <div key={i} style={{ ...S.linha, justifyContent: b.de === "eu" ? "flex-end" : "flex-start" }}>
            <div style={{ ...S.bolha, ...(b.de === "eu" ? S.bolhaEu : S.bolhaIa) }}>
              <div style={{ whiteSpace: "pre-wrap" }}>{b.texto}</div>
              <div style={{ ...S.hora, color: b.de === "eu" ? "rgba(0,0,0,.35)" : "#9aa5b1" }}>{b.hora}</div>
              {b.de === "ia" && <Avaliar agentId={A.id} mensagemIa={b.texto} sessionId={sessionId} />}
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

        {fu.aberto && (
          <div style={S.fuCard}>
            <div style={S.fuTitulo}>📅 E se o lead sumisse agora?</div>
            <div style={S.fuSub}>Estes são os toques REAIS que sairiam nesta conversa:</div>
            {fu.carregando && <div style={S.fuGerando}>gerando os 3 toques… (uns 20 segundos)</div>}
            {fu.erro && <div style={S.erro}>{fu.erro}</div>}
            {fu.toques.map((t) => (
              <div key={t.n} style={S.fuToque}>
                <div style={S.fuQuando}>
                  Toque {t.n} · {t.quando}
                </div>
                {t.quieto ? (
                  <div style={S.fuQuieto}>🤫 {t.motivo}</div>
                ) : (
                  <div style={{ ...S.bolha, ...S.bolhaIa, maxWidth: "100%" }}>
                    <div style={{ whiteSpace: "pre-wrap" }}>{t.texto}</div>
                  </div>
                )}
              </div>
            ))}
            {!fu.carregando && fu.nota && <div style={S.fuNota}>{fu.nota}</div>}
            <button style={S.fuFechar} onClick={() => setFu((f) => ({ ...f, aberto: false }))}>
              fechar
            </button>
          </div>
        )}
        <div ref={fim} />
      </div>

      {temConversa && !fu.aberto && (
        <div style={S.acoesLinha}>
          <button onClick={verFollowUps} style={{ ...S.btnAcao, borderColor: A.cor, color: A.cor }}>
            📅 E se o lead sumisse agora?
          </button>
          <button onClick={() => setChipsAbertos((v) => !v)} style={S.btnAcao}>
            😈 provocar
          </button>
          <button onClick={recomecar} style={S.btnAcao}>
            ↺ recomeçar
          </button>
        </div>
      )}

      {chipsAbertos && (
        <div style={S.chipsMeio}>
          {CHIPS_MEIO[agente].map((ex) => (
            <button key={ex} style={S.chipSugestaoMini} onClick={() => mandar(ex)}>
              {ex}
            </button>
          ))}
        </div>
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
        <button type="submit" disabled={carregando || !txt.trim()} style={{ ...S.btnEnviar, background: A.cor }}>
          ➤
        </button>
      </form>
    </>
  );
}

// ─────────────────────────────────────────────── Avaliar (👍/👎 + sugestão)
function Avaliar({ agentId, mensagemIa, sessionId }: { agentId: string; mensagemIa: string; sessionId?: string | null }) {
  const [feito, setFeito] = useState<"positive" | "negative" | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  const [sugestao, setSugestao] = useState("");
  const [salvo, setSalvo] = useState(false);

  async function marcar(rating: "positive" | "negative", texto?: string) {
    setFeito(rating);
    await fetch("/api/alves/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        tipo: "nota",
        rating,
        mensagem_ia: mensagemIa,
        sugestao: texto || undefined,
        session_id: sessionId || undefined,
      }),
    }).catch(() => {});
    if (texto) {
      setSalvo(true);
      setAbrindo(false);
    }
  }

  return (
    <div style={S.avaliar}>
      <button onClick={() => marcar("positive")} style={{ ...S.btnMini, ...(feito === "positive" ? S.btnMiniOk : {}) }}>
        👍
      </button>
      <button
        onClick={() => {
          marcar("negative");
          setAbrindo(true);
        }}
        style={{ ...S.btnMini, ...(feito === "negative" ? S.btnMiniNao : {}) }}
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
            placeholder="escreve do jeito de vocês — é isso que ela aprende"
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

// ─────────────────────────────────────────────────────────── Melhorias
const MELHORIAS: Array<{ voce: string; agora: string }> = [
  {
    voce: "“Pediu o nome 5 vezes… já tem o nome”",
    agora:
      "Trava de SISTEMA (não é só instrução): pergunta que o lead ignorou não aparece uma 3ª vez — a IA muda de ângulo ou segue sem o dado. Vale na conversa E nos follow-ups.",
  },
  {
    voce: "“Follow up chato”",
    agora:
      "Cada toque agora tem um ângulo diferente (retomar o assunto → valor da conversa → porta aberta), nunca repete pergunta nem horário. E dá pra VER os toques antes: botão “E se o lead sumisse agora?” aqui na conversa.",
  },
  {
    voce: "Lead de anúncio ficava sem resposta até ativar na mão",
    agora:
      "Lead de anúncio ativa SOZINHO no agente certo (seguro → Bruna, carreira → Bruno), pela própria mensagem do anúncio. O campo AI vira só o botão de desligar por contato. Cliente antigo da carteira continua fora, como tem que ser.",
  },
  {
    voce: "A IA disse “não é recrutamento” pra uma lead do anúncio de recrutamento",
    agora:
      "Proibido negar qualquer frente da empresa. Se um lead cair com o agente errado, ele reconhece na PRIMEIRA resposta, passa pro time certo e o time é avisado na hora.",
  },
  {
    voce: "“Ele nem sabe pra que serve essa reunião e você não falou que é por Zoom”",
    agora:
      "Nenhum horário é oferecido antes do lead saber o que está aceitando: conversa por Zoom de ~30 min com especialista, sem custo e sem compromisso. E se o lead disser “só ligação”, ela registra e marca como ligação.",
  },
  {
    voce: "Datas e dias da semana errados, “hoje/amanhã” confuso",
    agora:
      "Data agora é conferida por CÓDIGO antes de sair: dia-da-semana sempre bate com a data, “hoje/amanhã” vira data completa (“quinta-feira, 27/08”), fuso sempre explícito.",
  },
  {
    voce: "“Não precisava falar isso” (— vou seguir em espanhol)",
    agora: "Sem narração de processo: ela simplesmente faz. Lead escreve em espanhol? Ela responde em espanhol e pronto.",
  },
  {
    voce: "Tom robótico / textão",
    agora:
      "Tom calibrado pelo jeito de VOCÊS (inclusive pela conversa que o Marcos mesmo fez com a Andréia): bolhas curtas, natural, zero gíria pesada. E os 👍/👎 desta tela entram no comportamento dela no turno seguinte.",
  },
];

function Melhorias() {
  return (
    <div style={S.paine}>
      <div style={S.melhoriasHead}>
        <h2 style={S.h2}>O que mudou depois do feedback de vocês</h2>
        <p style={S.subDark}>
          Cada item abaixo nasceu de uma reclamação real de vocês. Foi tudo corrigido, testado em 3 rodadas
          com 8 perfis de lead difíceis + baterias automáticas de data, preço e agendamento — e está no ar
          esperando a religa.
        </p>
      </div>
      {MELHORIAS.map((m, i) => (
        <div key={i} style={S.melhoriaCard}>
          <div style={S.melhoriaVoce}>{m.voce}</div>
          <div style={S.melhoriaAgora}>{m.agora}</div>
        </div>
      ))}
      <div style={S.melhoriaRodape}>
        Testem à vontade nas outras abas — e usem o 👎 sem dó: é o jeito mais rápido de ajustar qualquer coisa.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Ideias
function Ideias({ agente }: { agente: AgenteKey }) {
  const [texto, setTexto] = useState("");
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    if (!texto.trim() || enviando) return;
    setEnviando(true);
    try {
      await fetch("/api/alves/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: AGENTES[agente].id, tipo: "sugestao", texto }),
      });
      setEnviado(true);
      setTexto("");
      setTimeout(() => setEnviado(false), 3000);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={S.paine}>
      <h2 style={S.h2}>Ideias e ajustes</h2>
      <p style={S.subDark}>
        Frase que a {AGENTES[agente].nome} nunca deveria falar, jeito melhor de responder algo, cenário que
        vocês querem que a gente teste — manda aqui que vira ajuste.
      </p>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="escreve aqui…"
        style={S.textareaGrande}
      />
      <button onClick={enviar} disabled={!texto.trim() || enviando} style={S.btnPrimario}>
        {enviando ? "enviando…" : enviado ? "recebido ✓" : "Enviar"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── estilos
const S: Record<string, React.CSSProperties> = {
  splash: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b1220", padding: 20 },
  pulso: { width: 44, height: 44, borderRadius: "50%", background: "#0e7a5f", animation: "pulso 1.2s ease-in-out infinite" },
  cardLogin: { width: "100%", maxWidth: 360, background: "#101a2e", borderRadius: 20, padding: "36px 28px", display: "flex", flexDirection: "column", gap: 14, alignItems: "center", boxShadow: "0 20px 60px rgba(0,0,0,.45)" },
  logoLogin: { width: 64, height: 64, borderRadius: 18, background: "linear-gradient(135deg,#0e7a5f,#1d4ed8)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 800, letterSpacing: 1 },
  h1: { color: "#fff", fontSize: 20, fontWeight: 700, margin: 0, textAlign: "center" },
  sub: { color: "#8fa3c0", fontSize: 13.5, lineHeight: 1.5, textAlign: "center", margin: 0 },
  inputPin: { width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #24344f", background: "#0b1220", color: "#fff", fontSize: 26, textAlign: "center", letterSpacing: 12, outline: "none" },
  erro: { color: "#f87171", fontSize: 13, margin: 0 },
  btnPrimario: { width: "100%", padding: "13px 16px", borderRadius: 12, border: "none", background: "#0e7a5f", color: "#fff", fontSize: 15.5, fontWeight: 700, cursor: "pointer" },

  pagina: { minHeight: "100dvh", display: "flex", flexDirection: "column", background: "#eef1f4", maxWidth: 640, margin: "0 auto", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", color: "#fff", position: "sticky", top: 0, zIndex: 5, transition: "background .25s" },
  avatar: { width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,.18)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17 },
  tituloTopo: { fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  subTopo: { fontSize: 11.5, opacity: 0.85, display: "flex", alignItems: "center", gap: 6 },
  pontinho: { width: 7, height: 7, borderRadius: "50%", background: "#7CFC9B", display: "inline-block" },
  switchAgente: { display: "flex", background: "rgba(0,0,0,.22)", borderRadius: 10, padding: 3, gap: 3 },
  switchBtn: { border: "none", background: "transparent", color: "rgba(255,255,255,.75)", fontSize: 12.5, fontWeight: 700, padding: "6px 10px", borderRadius: 8, cursor: "pointer" },
  switchBtnOn: { background: "#fff", color: "#111" },

  main: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  chat: { flex: 1, overflowY: "auto", padding: "14px 12px 8px", display: "flex", flexDirection: "column", gap: 8 },
  aviso: { background: "#fdf6dd", border: "1px solid #f1e3a9", color: "#6b5d1f", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, lineHeight: 1.45, margin: "0 4px 6px" },
  sugestoesIniciais: { display: "flex", flexDirection: "column", gap: 8, padding: "6px 4px" },
  chipsTitulo: { fontSize: 12, color: "#7b8794", fontWeight: 600 },
  chipSugestao: { textAlign: "left", background: "#fff", border: "1px solid #d7dee6", borderRadius: 12, padding: "10px 13px", fontSize: 13.5, color: "#33404d", cursor: "pointer", lineHeight: 1.4 },
  chipsMeio: { display: "flex", gap: 8, overflowX: "auto", padding: "8px 12px", background: "#e6ebf0" },
  chipSugestaoMini: { flexShrink: 0, background: "#fff", border: "1px solid #d7dee6", borderRadius: 20, padding: "7px 13px", fontSize: 12.5, color: "#33404d", cursor: "pointer", whiteSpace: "nowrap" },

  linha: { display: "flex", width: "100%" },
  bolha: { maxWidth: "82%", borderRadius: 14, padding: "9px 12px 6px", fontSize: 14.2, lineHeight: 1.45, boxShadow: "0 1px 1px rgba(0,0,0,.06)" },
  bolhaEu: { background: "#d7fdd0", color: "#0b2810", borderBottomRightRadius: 4 },
  bolhaIa: { background: "#fff", color: "#1f2a36", borderBottomLeftRadius: 4 },
  hora: { fontSize: 10.5, textAlign: "right", marginTop: 3 },
  ponto: { width: 7, height: 7, borderRadius: "50%", background: "#b9c3cd", display: "inline-block", animation: "pula 1s infinite" },

  acoesLinha: { display: "flex", gap: 8, padding: "6px 12px", overflowX: "auto", background: "transparent" },
  btnAcao: { flexShrink: 0, background: "#fff", border: "1.5px solid #cbd5e1", color: "#334155", borderRadius: 20, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  fuCard: { background: "#0f172a", borderRadius: 16, padding: "14px 14px 12px", margin: "6px 2px", color: "#e2e8f0", display: "flex", flexDirection: "column", gap: 10 },
  fuTitulo: { fontWeight: 800, fontSize: 15 },
  fuSub: { fontSize: 12.5, color: "#94a3b8", marginTop: -6 },
  fuGerando: { fontSize: 13, color: "#7dd3fc", padding: "6px 0" },
  fuToque: { display: "flex", flexDirection: "column", gap: 6 },
  fuQuando: { fontSize: 11.5, fontWeight: 800, color: "#7dd3fc", textTransform: "uppercase", letterSpacing: 0.5 },
  fuQuieto: { fontSize: 13, color: "#cbd5e1", background: "rgba(255,255,255,.07)", borderRadius: 10, padding: "9px 12px", fontStyle: "italic" },
  fuNota: { fontSize: 11.5, color: "#94a3b8", borderTop: "1px solid rgba(255,255,255,.12)", paddingTop: 9 },
  fuFechar: { alignSelf: "flex-end", background: "transparent", border: "none", color: "#7dd3fc", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 4 },

  barra: { display: "flex", gap: 8, padding: "8px 10px calc(8px + env(safe-area-inset-bottom))", background: "#eef1f4", position: "sticky", bottom: 46 },
  inputBarra: { flex: 1, borderRadius: 22, border: "1px solid #d0d8e0", padding: "11px 16px", fontSize: 14.5, outline: "none", background: "#fff" },
  btnEnviar: { width: 44, height: 44, borderRadius: "50%", border: "none", color: "#fff", fontSize: 17, cursor: "pointer", flexShrink: 0 },

  avaliar: { display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
  btnMini: { border: "1px solid #e2e8f0", background: "#f8fafc", borderRadius: 8, padding: "3px 8px", fontSize: 13, cursor: "pointer" },
  btnMiniOk: { background: "#dcfce7", borderColor: "#86efac" },
  btnMiniNao: { background: "#fee2e2", borderColor: "#fca5a5" },
  btnMiniTexto: { border: "none", background: "transparent", color: "#64748b", fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  okMini: { fontSize: 11.5, color: "#16a34a", fontWeight: 700 },
  textareaMini: { width: "100%", minHeight: 64, borderRadius: 10, border: "1px solid #d0d8e0", padding: "9px 11px", fontSize: 13.5, resize: "vertical" },
  btnMiniSalvar: { marginTop: 6, background: "#0e7a5f", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },

  paine: { padding: "18px 16px 24px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" },
  melhoriasHead: { marginBottom: 2 },
  h2: { fontSize: 18, fontWeight: 800, color: "#0f172a", margin: "0 0 6px" },
  subDark: { fontSize: 13.5, color: "#475569", lineHeight: 1.5, margin: 0 },
  melhoriaCard: { background: "#fff", borderRadius: 14, padding: "13px 14px", boxShadow: "0 1px 2px rgba(0,0,0,.06)" },
  melhoriaVoce: { fontSize: 13, color: "#b91c1c", fontWeight: 700, marginBottom: 6 },
  melhoriaAgora: { fontSize: 13.5, color: "#1f2a36", lineHeight: 1.5 },
  melhoriaRodape: { fontSize: 13, color: "#475569", textAlign: "center", padding: "8px 12px" },
  textareaGrande: { width: "100%", minHeight: 140, borderRadius: 12, border: "1px solid #d0d8e0", padding: "12px 14px", fontSize: 14.5, resize: "vertical", background: "#fff" },

  tabbar: { display: "flex", background: "#fff", borderTop: "1px solid #e2e8f0", position: "sticky", bottom: 0, zIndex: 5 },
  tab: { flex: 1, border: "none", background: "transparent", padding: "11px 4px calc(11px + env(safe-area-inset-bottom))", fontSize: 12.5, fontWeight: 700, color: "#94a3b8", cursor: "pointer" },
  tabOn: { color: "#0e7a5f" },
};

const CSS_GLOBAL = `
  html, body { margin: 0; padding: 0; background: #eef1f4; }
  * { box-sizing: border-box; }
  @keyframes pulso { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.25); opacity: .55; } }
  @keyframes pula { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }
  button:active { transform: scale(.985); }
  input:focus, textarea:focus { border-color: #0e7a5f !important; }
`;
