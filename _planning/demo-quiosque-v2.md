# Demo de convenção V2 — "Na mão → por voz → sozinho" (2026-06-11)

Refactor da experiência `/demo` (quiosque iPad). Decisões do Pedro (sessão 2026-06-11):
**plataforma única** (Spark Leads CRM + SparkBot numa jornada), **toques guiados** no CRM,
**self-service**, **nome capturado no início** (personaliza a demo toda).

## Arco novo (5 cenas, 3 atos, ~2min30)

`attract → nome → demo → cadastro → sucesso`

| # | Ato | Cena | Interação | Continuidade |
|---|-----|------|-----------|--------------|
| 1 | 1 · Você no comando | Funil na mão (kanban fullscreen) | arrasta o João pra Proposta (fallback tap-tap) | João chega em Proposta |
| 2 | 1 | Ficha da Maria (lista + ficha) | toca na Maria | planta o follow-up vencido |
| 3 | 2 · Agora por voz | Agendar por áudio (split chat+CRM) | segura o mic | agenda do CRM da cena 1 |
| 4 | 2 | Atualizar falando | segura o mic | João Proposta→Consideração (eco da cena 1) |
| 5 | 3 · Ele trabalha sozinho | Proativo | nenhuma | resolve o follow-up da Maria (cena 2) |

Personalização: `{vocativo}` nos textos do bot, chip do user no chrome do CRM, "Painel de {Nome}".

## Gate de paridade vs legado (anti-pattern CLAUDE.md)

| Item do flow anterior | Status no novo | Tipo |
|---|---|---|
| Attract: ticker áudios, 2 CTAs, badge convenção | mantidos; copy → plataforma; CTA primário → `#nome` | (a) decisão |
| Cena "Agendar por voz" | mantida (cena 3) | — |
| Cena "Atualizar lead" | mantida (cena 4) | — |
| Cena "Especialista no bolso" (CrmKnowledge) | **CORTADA** pra segurar 2min30 (aprovado Pedro). Recuperável: commit `e969491` | (a) decisão |
| Cena "Proativo" | mantida (cena 5, clímax) | — |
| Chat: hold-to-record, waveform, transcrição | mantidos | — |
| CRM: agenda / kanban / dashboard | mantidos + kanban ganhou versão interativa | — |
| Cadastro: 3 campos, máscara BR, placeholder planos | mantidos; nome pré-preenchido da tela do nome | (a) decisão |
| Sucesso: confete, passos 1-2-3, CTAs | mantidos; copy → plataforma | (a) decisão |
| Kiosk: idle reset 90s, hash routing, teclas, setas, palco escalado | mantidos; +rota `nome`, teclas 1-5, reset limpa o nome | (a) decisão |
| `POST /api/demo/lead` (não existia — D5) | **criado** + fila offline localStorage + migration `00107_demo_leads` + `scripts/import-demo-leads.ts` | fix |

## Follow-ups
- [ ] Testar o DRAG real no iPad físico (validado no preview só via fallback tap-tap e pointer sintético; conversão de escala implementada em `CrmTouch.tsx:toBoardCoords`).
- [x] ~~Reintroduzir "Especialista no bolso"~~ — RESTAURADA 2026-06-12 (pedido do Pedro) como cena 5 do Ato 2, conteúdo adaptado pra National Life (FlexLife/IUL, term com conversão, LIRP). Demo agora tem 6 cenas (~2min50).
- [ ] Rodar `scripts/import-demo-leads.ts <locationId>` depois do evento (leads ficam em `demo_leads`, RLS service-role-only).

## Ajustes pós-review no iPad (Pedro 2026-06-12)
- **Formato US**: máscara do WhatsApp (407) 555-0123, endpoint normaliza +1.
- **Checkout via QR** na tela de sucesso → sparkleads.pro/#planos.
- **Idle reset por rota** (90s fixo cortava cadastro/scan): nome/demo 120s, cadastro 300s, sucesso 240s + bump em `input`/`focusin` (teclado virtual do iPad não emite pointer/keydown confiável).
- **Setinhas discretas** nas bordas do ScreenDemo: pulam cenas sem completar a interação (pro time apresentar no próprio ritmo).

## Bugs pegos na verificação (já fixados)
- `autoFocus` da tela do nome scrollava o palco (overflow:hidden tem scrollTop) → `focus({preventScroll})` + guard anti-scroll no stage (cobre teclado do iPad).
- Troca de cena montava a cena nova com phase antiga ("complete") → cenas touch nasciam resolvidas. Fix: `changeScene()` seta índice+phase no mesmo batch.
- Headline "CRM completo." não cabia em display-xl 96px → 64px.
