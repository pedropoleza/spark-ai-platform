/**
 * Gera o guia em PDF pra Bianca e a Sofia — o que mudou nas IAs do Instagram,
 * como ligar/desligar pelo celular e o que esperar de cada uma.
 *
 * Visual em pdf-lib (Helvetica cobre acentos PT-BR; emoji é removido pelo
 * sanitize — WinAnsi não tem). Saída: _planning/bianca-agentes-2026-08/.
 *
 *   npx tsx scripts/gerar-guia-bianca-pdf.ts
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { writeFileSync } from "fs";
import { resolve } from "path";

const A4 = { w: 595.28, h: 841.89 };
const M = 48; // margem

const ROXO = rgb(0.42, 0.29, 0.85);
const ROXO_CLARO = rgb(0.93, 0.91, 0.99);
const VERDE = rgb(0.06, 0.6, 0.35);
const VERDE_CLARO = rgb(0.89, 0.97, 0.93);
const VERM = rgb(0.78, 0.15, 0.2);
const VERM_CLARO = rgb(0.99, 0.92, 0.92);
const CINZA = rgb(0.42, 0.45, 0.5);
const CINZA_CLARO = rgb(0.95, 0.96, 0.97);
const PRETO = rgb(0.1, 0.12, 0.15);
const BRANCO = rgb(1, 1, 1);

const limpa = (s: string) => (s || "").replace(/[^\t\n\r\x20-\x7E\xA0-\xFF]/g, "").trim();

function quebra(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const w of para.split(/\s+/)) {
      const cand = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(cand, size) <= maxW) line = cand;
      else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

async function main() {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const novaPagina = (): { p: PDFPage; y: () => number; setY: (v: number) => void } => {
    const p = doc.addPage([A4.w, A4.h]);
    let cursor = A4.h - M;
    return { p, y: () => cursor, setY: (v) => { cursor = v; } };
  };

  const texto = (p: PDFPage, s: string, x: number, y: number, f: PDFFont, size: number, color = PRETO) =>
    p.drawText(limpa(s), { x, y, size, font: f, color });

  const paragrafo = (ctx: ReturnType<typeof novaPagina>, s: string, f: PDFFont, size: number, color = PRETO, maxW = A4.w - 2 * M, x = M) => {
    for (const l of quebra(limpa(s), f, size, maxW)) {
      if (l) texto(ctx.p, l, x, ctx.y(), f, size, color);
      ctx.setY(ctx.y() - (size + 5));
    }
  };

  const caixa = (p: PDFPage, x: number, y: number, w: number, h: number, fill: ReturnType<typeof rgb>, borda?: ReturnType<typeof rgb>) =>
    p.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: borda, borderWidth: borda ? 1.2 : 0 });

  const seta = (p: PDFPage, x1: number, y1: number, x2: number, y2: number, cor = CINZA) => {
    p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.6, color: cor });
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const L = 7;
    p.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - L * Math.cos(ang - 0.4), y: y2 - L * Math.sin(ang - 0.4) }, thickness: 1.6, color: cor });
    p.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 - L * Math.cos(ang + 0.4), y: y2 - L * Math.sin(ang + 0.4) }, thickness: 1.6, color: cor });
  };

  const titulo = (ctx: ReturnType<typeof novaPagina>, t: string, sub?: string) => {
    caixa(ctx.p, 0, A4.h - 92, A4.w, 92, ROXO);
    texto(ctx.p, t, M, A4.h - 52, bold, 21, BRANCO);
    if (sub) texto(ctx.p, sub, M, A4.h - 73, reg, 10.5, rgb(0.88, 0.85, 0.99));
    ctx.setY(A4.h - 124);
  };

  const secao = (ctx: ReturnType<typeof novaPagina>, t: string) => {
    ctx.setY(ctx.y() - 8);
    texto(ctx.p, t, M, ctx.y(), bold, 13, ROXO);
    ctx.p.drawLine({ start: { x: M, y: ctx.y() - 6 }, end: { x: A4.w - M, y: ctx.y() - 6 }, thickness: 1, color: ROXO_CLARO });
    ctx.setY(ctx.y() - 24);
  };

  // ══════════════════ PÁGINA 1 — o que mudou ══════════════════
  {
    const c = novaPagina();
    titulo(c, "As IAs do Instagram da Bianca", "Guia para a Bianca e a Sofia  ·  26 de agosto de 2026");

    paragrafo(c, "Resumo em uma frase: agora existem DUAS IAs, cada uma com um público, e você liga ou desliga qualquer uma pelo celular usando uma etiqueta (tag).", reg, 11);
    c.setY(c.y() - 6);

    secao(c, "O que estava acontecendo antes");
    const problemas = [
      ["A IA quase não respondia", "Ela só entrava se a pessoa mandasse UMA frase exata do anúncio, com vírgula e tudo. Em 30 dias, 222 pessoas escreveram e ficaram sem resposta."],
      ["A IA não conseguia agendar", "O calendário nunca tinha sido ligado na configuração. Ela conversava, mas não tinha como marcar a reunião."],
      ["Só dava pra ligar no computador", "O botão de ligar a IA aparece no Spark Leads do navegador. No aplicativo do celular ele não existe."],
    ];
    for (const [t, d] of problemas) {
      const alturas = quebra(d, reg, 10, A4.w - 2 * M - 30).length;
      const h = 22 + alturas * 14;
      caixa(c.p, M, c.y() - h + 14, A4.w - 2 * M, h, VERM_CLARO);
      caixa(c.p, M, c.y() - h + 14, 3.5, h, VERM);
      texto(c.p, t, M + 14, c.y(), bold, 11, VERM);
      c.setY(c.y() - 16);
      paragrafo(c, d, reg, 10, PRETO, A4.w - 2 * M - 30, M + 14);
      c.setY(c.y() - 12);
    }

    secao(c, "O que mudou");
    const solucoes = [
      ["A IA de anúncio agora reconhece quem veio de anúncio", "Não depende mais da frase. O próprio Spark Leads sabe que a pessoa clicou num anúncio, e a IA usa isso."],
      ["Ela já consegue marcar reunião na sua agenda", "Calendário 1:1 ligado, com visão de 14 dias pra frente."],
      ["Nasceu a IA de novos seguidores", "Uma segunda IA, com o seu jeito de conversar: quer conhecer a pessoa, sem empurrar reunião."],
      ["Cliente e contato pessoal ficam de fora, sempre", "Quem tem etiqueta de cliente, contato pessoal ou membro da agência nunca é abordado por nenhuma das duas."],
      ["Você liga e desliga pelo celular", "Duas etiquetas novas fazem isso, sem precisar de computador."],
    ];
    for (const [t, d] of solucoes) {
      const alturas = quebra(d, reg, 10, A4.w - 2 * M - 30).length;
      const h = 22 + alturas * 14;
      caixa(c.p, M, c.y() - h + 14, A4.w - 2 * M, h, VERDE_CLARO);
      caixa(c.p, M, c.y() - h + 14, 3.5, h, VERDE);
      texto(c.p, t, M + 14, c.y(), bold, 11, VERDE);
      c.setY(c.y() - 16);
      paragrafo(c, d, reg, 10, PRETO, A4.w - 2 * M - 30, M + 14);
      c.setY(c.y() - 12);
    }
  }

  // ══════════════════ PÁGINA 2 — o diagrama ══════════════════
  {
    const c = novaPagina();
    titulo(c, "Quem fala com quem", "Como o sistema decide qual IA atende cada pessoa");

    paragrafo(c, "Quando alguém manda mensagem no Instagram, o sistema faz estas perguntas, nesta ordem:", reg, 11);
    c.setY(c.y() - 10);

    const cx = A4.w / 2;
    let y = c.y();

    // Bloco: mensagem chega
    caixa(c.p, cx - 110, y - 34, 220, 34, ROXO);
    texto(c.p, "Chegou mensagem no Instagram", cx - 96, y - 22, bold, 11, BRANCO);
    y -= 34;

    // Decisão 1 — exclusão
    seta(c.p, cx, y, cx, y - 26);
    y -= 26;
    caixa(c.p, cx - 190, y - 46, 380, 46, VERM_CLARO, VERM);
    texto(c.p, "1.  É cliente, contato pessoal ou membro da agência?", cx - 176, y - 19, bold, 10.5, VERM);
    texto(c.p, "Ou tem a etiqueta ia-desligada?   ->   NENHUMA IA responde. Fim.", cx - 176, y - 34, reg, 10, PRETO);
    y -= 46;

    // Decisão 2 — anúncio
    seta(c.p, cx, y, cx, y - 26);
    y -= 26;
    caixa(c.p, cx - 190, y - 58, 380, 58, ROXO_CLARO, ROXO);
    texto(c.p, "2.  A pessoa veio de um anúncio?", cx - 176, y - 19, bold, 10.5, ROXO);
    texto(c.p, "(o Spark Leads registra isso sozinho, no primeiro contato dela)", cx - 176, y - 33, reg, 9.5, CINZA);
    texto(c.p, "SIM  ->  IA de Tráfego Pago", cx - 176, y - 48, bold, 10, ROXO);
    y -= 58;

    // Decisão 3 — tag
    seta(c.p, cx, y, cx, y - 26);
    y -= 26;
    caixa(c.p, cx - 190, y - 58, 380, 58, VERDE_CLARO, VERDE);
    texto(c.p, "3.  Tem a etiqueta novo seguidor ou ia-ligada?", cx - 176, y - 19, bold, 10.5, VERDE);
    texto(c.p, "(quem coloca é você, pelo celular ou pelo computador)", cx - 176, y - 33, reg, 9.5, CINZA);
    texto(c.p, "SIM  ->  IA de Novos Seguidores", cx - 176, y - 48, bold, 10, VERDE);
    y -= 58;

    // Decisão 4 — nada
    seta(c.p, cx, y, cx, y - 26);
    y -= 26;
    caixa(c.p, cx - 190, y - 40, 380, 40, CINZA_CLARO, CINZA);
    texto(c.p, "4.  Nenhum dos casos acima", cx - 176, y - 18, bold, 10.5, CINZA);
    texto(c.p, "Ninguém responde automaticamente. O atendimento é de vocês.", cx - 176, y - 32, reg, 10, PRETO);
    y -= 40;

    c.setY(y - 26);
    secao(c, "As duas IAs, lado a lado");

    const col = (A4.w - 2 * M - 16) / 2;
    const topo = c.y();
    const alturaCard = 176;

    // Card A
    caixa(c.p, M, topo - alturaCard, col, alturaCard, ROXO_CLARO, ROXO);
    texto(c.p, "IA de Tráfego Pago", M + 12, topo - 22, bold, 12, ROXO);
    const linhasA = [
      "Quem atende: quem clicou no anúncio",
      "Entra sozinha, sem você fazer nada",
      "",
      "Objetivo: qualificar e marcar a",
      "reunião 1:1 com a Bianca",
      "",
      "Perguntas: estado, permissão de",
      "trabalho, profissão e motivação",
      "",
      "Lembretes: até 3, dentro de 24h",
      "(limite do Instagram)",
    ];
    let ya = topo - 42;
    for (const l of linhasA) { if (l) texto(c.p, l, M + 12, ya, reg, 9.5); ya -= 13; }

    // Card B
    const x2 = M + col + 16;
    caixa(c.p, x2, topo - alturaCard, col, alturaCard, VERDE_CLARO, VERDE);
    texto(c.p, "IA de Novos Seguidores", x2 + 12, topo - 22, bold, 12, VERDE);
    const linhasB = [
      "Quem atende: quem VOCÊ marcar",
      "com a etiqueta",
      "",
      "Objetivo: criar conexão. Só convida",
      "pra reunião se a pessoa demonstrar",
      "interesse de verdade",
      "",
      "Perguntas: leves, uma por vez -",
      "onde mora, o que faz, o que busca",
      "",
      "Lembretes: 1 só, depois de 4h",
    ];
    let yb = topo - 42;
    for (const l of linhasB) { if (l) texto(c.p, l, x2 + 12, yb, reg, 9.5); yb -= 13; }

    c.setY(topo - alturaCard - 18);
    paragrafo(c, "Importante: uma nunca rouba o lead da outra. Quem veio de anúncio fica sempre com a IA de Tráfego Pago, mesmo que receba a etiqueta de seguidor.", reg, 9.5, CINZA);
  }

  // ══════════════════ PÁGINA 3 — as etiquetas ══════════════════
  {
    const c = novaPagina();
    titulo(c, "As duas etiquetas", "Sofia: é assim que você liga e desliga a IA pelo celular");

    secao(c, "Passo a passo no aplicativo");
    const passos = [
      "Abra o contato no aplicativo do Spark Leads.",
      "Toque em Tags (etiquetas).",
      "Escolha a etiqueta na lista. Não digite - as duas já estão criadas.",
      "Pronto. A IA entra ou sai desse contato.",
    ];
    passos.forEach((p, i) => {
      caixa(c.p, M, c.y() - 6, 19, 19, ROXO);
      texto(c.p, String(i + 1), M + 7, c.y(), bold, 11, BRANCO);
      texto(c.p, p, M + 30, c.y(), reg, 11);
      c.setY(c.y() - 30);
    });

    c.setY(c.y() - 4);
    secao(c, "O que cada uma faz");

    const cards = [
      { tag: "ia-ligada", cor: VERDE, fundo: VERDE_CLARO, o: "LIGA a IA de Novos Seguidores nesse contato.",
        d: "Use quando quiser que a IA cuide de alguém que ela não pegaria sozinha.\n\nSe ninguem falou com a pessoa ainda, a IA manda a primeira mensagem.\nSe você já escreveu, ela espera a pessoa responder e assume dali." },
      { tag: "novo seguidor", cor: VERDE, fundo: VERDE_CLARO, o: "Mesmo efeito da ia-ligada.",
        d: "Já existia na conta e continua valendo. Use a que for mais natural pra você." },
      { tag: "ia-desligada", cor: VERM, fundo: VERM_CLARO, o: "DESLIGA qualquer IA nesse contato.",
        d: "Ganha de todas as outras regras. Use quando quiser assumir a conversa você mesma.\n\nPra devolver pra IA, é só tirar a etiqueta." },
    ];
    for (const cd of cards) {
      const linhas = quebra(cd.d, reg, 10, A4.w - 2 * M - 28);
      const h = 46 + linhas.length * 13;
      caixa(c.p, M, c.y() - h + 16, A4.w - 2 * M, h, cd.fundo, cd.cor);
      texto(c.p, cd.tag, M + 14, c.y(), bold, 13, cd.cor);
      c.setY(c.y() - 16);
      texto(c.p, cd.o, M + 14, c.y(), bold, 10, PRETO);
      c.setY(c.y() - 16);
      for (const l of linhas) { if (l) texto(c.p, l, M + 14, c.y(), reg, 10); c.setY(c.y() - 13); }
      c.setY(c.y() - 20);
    }

    c.setY(c.y() - 4);
    caixa(c.p, M, c.y() - 58, A4.w - 2 * M, 58, CINZA_CLARO, CINZA);
    texto(c.p, "Um cuidado só", M + 14, c.y() - 18, bold, 11, PRETO);
    texto(c.p, "Escolha sempre a etiqueta da lista, nunca digite uma nova. Uma etiqueta escrita", M + 14, c.y() - 33, reg, 9.5);
    texto(c.p, "diferente (IA Ligada, ia ligada) não funciona - o sistema procura a grafia exata.", M + 14, c.y() - 46, reg, 9.5);
  }

  // ══════════════════ PÁGINA 4 — o que esperar ══════════════════
  {
    const c = novaPagina();
    titulo(c, "O que esperar das IAs", "E quando chamar a gente");

    secao(c, "As duas nunca fazem isso");
    const nuncas = [
      "Prometer valor de ganho, mesmo se a pessoa insistir ou trouxer um número.",
      "Dizer que é humana. Se perguntarem se é robô, ela desconversa uma vez; se insistirem, passa pra vocês.",
      "Falar de contrato, comissão ou estrutura por escrito - isso fica pra conversa com a Bianca.",
      "Orientar sobre visto ou imigração, ou pedir documento.",
      "Prometer mandar algo por email ou WhatsApp - o canal é o Instagram.",
      "Oferecer um horário que não esteja livre na sua agenda.",
    ];
    for (const n of nuncas) {
      texto(c.p, "-", M, c.y(), bold, 11, VERM);
      paragrafo(c, n, reg, 10.5, PRETO, A4.w - 2 * M - 16, M + 14);
      c.setY(c.y() - 4);
    }

    c.setY(c.y() - 8);
    secao(c, "Quando a IA para sozinha");
    const paradas = [
      ["Vocês responderem na conversa", "Ela sai na hora e deixa o atendimento com vocês."],
      ["A pessoa pedir pra falar com alguém", "Ela avisa que o time entra em contato e para."],
      ["Assunto sensível ou que ela não sabe", "Ela não inventa: diz que vai verificar e para."],
    ];
    for (const [t, d] of paradas) {
      texto(c.p, t, M, c.y(), bold, 10.5, ROXO);
      c.setY(c.y() - 14);
      paragrafo(c, d, reg, 10, PRETO, A4.w - 2 * M - 16, M + 14);
      c.setY(c.y() - 8);
    }

    c.setY(c.y() - 6);
    secao(c, "Como saber o que a IA fez");
    paragrafo(c, "No Spark Leads pelo computador, cada contato mostra se a IA está ativa e marca as mensagens que ela enviou. As etiquetas origem-anuncio-ia e origem-seguidor-ia dizem qual das duas atendeu, e agendado-anuncio-ia / agendado-seguidor-ia mostram de onde veio cada reunião marcada - é assim que a gente vai medir qual caminho traz mais resultado.", reg, 10.5);

    c.setY(c.y() - 14);
    caixa(c.p, M, c.y() - 74, A4.w - 2 * M, 74, ROXO_CLARO, ROXO);
    texto(c.p, "Se algo parecer errado", M + 14, c.y() - 20, bold, 12, ROXO);
    texto(c.p, "Coloque a etiqueta ia-desligada no contato - isso para a IA na hora - e nos", M + 14, c.y() - 38, reg, 10);
    texto(c.p, "mande um print da conversa. Tudo que as IAs fazem fica registrado, então a", M + 14, c.y() - 52, reg, 10);
    texto(c.p, "gente consegue olhar exatamente o que aconteceu e corrigir.", M + 14, c.y() - 66, reg, 10);

    texto(c.p, "Spark Leads  ·  26/08/2026", M, 40, reg, 8.5, CINZA);
  }

  const bytes = await doc.save();
  const out = resolve(__dirname, "..", "_planning", "bianca-agentes-2026-08", "GUIA-IAs-Bianca-Sofia.pdf");
  writeFileSync(out, bytes);
  console.log(`✅ PDF gerado: ${out}`);
  console.log(`   ${doc.getPageCount()} páginas · ${(bytes.length / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
