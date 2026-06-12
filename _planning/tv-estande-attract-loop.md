# TV do estande — attract loop `/tv` (plano, 2026-06-11)

TV grande no estande da convenção rodando um **loop de telas animadas** (10s cada),
sem interação. Objetivo: parar gente no corredor e empurrar pro tablet (demo) e pro QR.
Decisões do Pedro: **tema dark premium** (quiosque continua claro — contraste proposital),
**QR → app.sparkleads.pro**, **sem números/prova social** (só value props).

## Princípios (TV ≠ tablet)

1. **Legível a 4-6 metros**: tipo mínimo ~32px no palco; máx. 8 palavras por headline; alto contraste.
2. **Sempre em movimento**: cada tela tem ROTEIRO interno dos seus 10s (não é slide estático — algo anima do segundo 0 ao 10).
3. **Zero rede em runtime**: mesma filosofia do quiosque (fonte self-hosted, assets locais, QR pré-gerado). Carregou uma vez, roda pra sempre.
4. **Roda 8h+ sem degradar**: remount limpo por tela, timers centralizados, reload silencioso periódico.
5. **Dark premium**: fundo `--bg-deep` (#0A1620, já existe), cyan #0FB5E1 com glow, partículas sutis. TV branca ofusca em evento; dark destaca.

## Arquitetura

- **Rota `/tv`** no mesmo app (padrão do `/demo`): client-only, sem auth, `noindex`.
  - `src/app/tv/layout.tsx` — Jakarta via next/font, tv.css, PWA meta (caso rode num tablet pendurado).
  - `src/app/tv/page.tsx` — palco **1920×1080** (16:9) auto-escalado com letterbox preto (mesmo scaler do quiosque) → qualquer TV/projetor.
  - `src/app/tv/tv.css` — tokens dark + keyframes (base no demo.css).
  - `src/app/tv/screens/*.tsx` — 1 arquivo por tela.
  - `src/app/tv/data.ts` — roteiros/textos (fonte única, fácil ajustar copy).
- **Motor de rotação** (`Rotator`):
  - Lista `{screen, duration}` (default 10s; override `?s=12`).
  - Transição crossfade + leve slide/zoom (~600ms), `key` por tela = remount limpo (zera animações e timers da tela).
  - Barra de progresso discreta no rodapé + dots.
  - Modo teste: `?screen=funil` fixa uma tela; espaço pausa/avança.
  - `location.reload()` silencioso a cada ~4h (higiene de memória pra rodar o evento inteiro).
  - Screen Wake Lock API quando disponível (evita TV/tablet dormir).
- **QR**: SVG pré-gerado no build (sem dependência de runtime) → `https://app.sparkleads.pro?utm_source=tv-convencao-2026`.
- **Reuso**: mascotes PNG, conceitos das cenas do quiosque e keyframes — mas as telas são REDESENHADAS pra dark/16:9/tipografia gigante (componentes light do /demo não servem direto).

## As 7 telas (loop ≈ 70s)

| # | Tela | Roteiro dos 10s |
|---|------|-----------------|
| 1 | **Abertura** — "CRM completo. Operado por voz." | 0-2s logo K entra com glow pulsante · 2-5s headline digita · 5-10s chips orbitam o mascote (Funil, Agenda, WhatsApp, IA) |
| 2 | **Você fala. Ele resolve.** — chat WhatsApp gigante | 0-2s bolha de áudio entra, waveform animando · 2-4s transcrição revela · 4-6s typing dots · 6-10s resposta do bot + ✓✓ + pill "agendado" |
| 3 | **O funil se move sozinho** — kanban dark neon | 0-3s colunas entram em stagger · 3-6s card desliza Contato→Proposta com rastro de glow + badge "movido" · 6-10s valores do funil sobem (counter) |
| 4 | **Agenda cheia. Sem digitar.** — agenda semanal | 0-3s grid desenha · 3-8s eventos pingam um a um · 8-10s evento NOVO com glow + "convite enviado no WhatsApp" |
| 5 | **Ele trabalha enquanto você atende** — proativo | 0-3s alerta "Maria esfriou há 7 dias" · 3-6s follow-up digitando + "enviado às 09:42" · 6-10s feed de atividade rolando |
| 6 | **Por que Spark Leads** — 4 value props | Cards grandes entram em stagger com ícones animados: Funil visual · WhatsApp no CRM · Copiloto de voz · Follow-up sozinho |
| 7 | **Bora ver ao vivo** — CTA + QR | Mascote celebrating + "Faz a demo no tablet aqui do lado 👉" + QR grande + URL legível (app.sparkleads.pro) |

Loop de ~70s = quem parar 1 minuto vê a história inteira. Ordem conta a mesma
narrativa do quiosque (produto → voz → autonomia → CTA), versão passiva.

## Verificação antes do evento

- Preview 1920×1080: screenshot das 7 telas + transições.
- Soak test: deixar rodando 30min+ monitorando memória (sem crescimento) e timers.
- `tsc` + `next build` + deploy + smoke em prod.

## Operação no estande (não é código)

- **Mais confiável**: notebook no HDMI da TV, Chrome fullscreen (F11) em `spark-ai-platform.vercel.app/tv`, energia ligada, sleep desativado.
- Alternativas: browser de smart TV (testar antes — varia muito) ou Fire Stick com browser.
- Abrir a página AINDA com internet (carrega tudo); depois aguenta queda de wifi.

## Esforço

~1 dia: motor+palco (1h) → 7 telas (30-45min cada) → polish/soak/deploy.

## Aberto

- [ ] Como a TV vai ser alimentada (notebook+HDMI / stick / smart TV)? Só muda instrução de operação.
- [ ] Validar o QR com utm no analytics do site (se houver).
