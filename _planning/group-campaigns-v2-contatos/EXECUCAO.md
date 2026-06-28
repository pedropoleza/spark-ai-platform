# EXECUÇÃO — Group Campaigns V2 (H46) — tracker do /loop autónomo

> Estado vivo do build. Cada iteração do loop atualiza isto. PLANO em `PLANO.md`.
> Objetivo: bug-proof, bem testado, consistente com o sistema. Flags OFF até o fim.

## Decisões do Pedro (2026-06-28) — baixadas
1. Número = o do DM (ban aceito+avisado, sem dedicado). 2. Contato-grupo criado auto pelo Stevo (persiste). 3. Áudio em `.wav`. 4. Billing 1 grupo=1 contato ok.

## Ordem de migrations (CORRIGIDA — FK exige rep_media antes das colunas que a referenciam)
- `00119` group_contacts (cache) + `bulk_message_recipients.is_group` (F1 precisa do is_group p/ pular opt-out)
- `00120` rep_media (tabela) — **antes** das FKs
- `00121` colunas de mídia outbound (media_id FK→rep_media, media_type) em followup_messages/bulk_message_recipients/draft_steps
- `00122` cockpit (label, paused_at, edited_at, edit_count em bulk_message_recipients)

## Fases & estado
- [~] **F1** Detector + descoberta + cache + envio de texto via GHL (fundação pronta)
  - [x] F1.1 `group-contacts/detector.ts` (puro, 26/26) + test — commit 99f2085
  - [x] F1.2 migration 00119 (group_contacts + is_group + RLS) — commit 99f2085
  - [x] F1.3 `group-contacts/sync.ts` + `repositories/group-contacts.repo.ts` (helpers 17/17) — commit (sync)
  - [x] F1.6 flag `isGroupCampaignsV2Enabled`/`isRepMediaEnabled` + caps enforçados — commit (config)
  - [x] F1.4 rewire `tools/group-campaigns.ts` (gate dedicada removido, getGroupContacts/resolveGroupTargets, contact_id real + is_group, gate V2) — commit d3222bf
  - [x] F1.5 rewire `bulk-message-runner.ts` (deletado sendToGroup+branch; pula opt-out/cooldown/assign por is_group; is_group do claim RETURNS SETOF) — commit 7b5e5bc
  - [x] F1.7 review adversarial (3 frentes) + 4 fixes (clampGroupInterval teto, dedup jid + .ok check, guard anti-wipe, resync on notFound, quiet-hours por is_group) — sync 29/29 · commit
  - ⏳ smoke E2E ao vivo (👤 precisa do "pode" — manda msg real no grupo do Matheus)
  - ⚠️ DÍVIDA p/ F5: `recurring-runner` (branch groups) lê `group_targets[].jid` (shape velho) **E** monta recipients SEM `is_group` nem `contact_id` real → trocar p/ `contact_id: g.contact_id` + `is_group: true` (espelhar o schedule). Flag OFF (RECURRING+V2) até F5, sem risco.

**✅ F1 COMPLETO (código+review)** — 7 commits, detector 26/26 · sync 29/29 · H40 43/43 · tsc limpo. Falta só o E2E ao vivo (gated pelo Pedro).
- [x] **F2** Blindagem inbound + caps anti-ban + Termos ponto 3 — commit
  - [x] Gate @g.us no `webhook-handler` (early-return antes de opt-out/pause/variant/resposta) via cache + flag V2 + fail-soft; helper `isCachedGroupContact`
  - [x] Caps enforçados `caps.ts` (evaluateGroupCaps puro 8/8 + checkGroupDailyCaps 2-query fail-open) wired no schedule
  - [x] Termos ponto 3 reescrito (número=DM, ban derruba os dois)
  - [x] review adversarial do F2 (1f location-mismatch = CLEAN) → 1 HIGH + 1 LOW corrigidos: recurring-runner puxado pro modelo H46 (resolve a dívida do F5!) + regressão @g.usuario.com

**✅ F2 COMPLETO (código+review)** — detector 28/28 · caps 8/8 · sync 29/29 · H40 43/43 · tsc limpo. (recurring-runner shape JÁ resolvido aqui → F5 fica só com anti-contaminação + retirada H40 + paridade.)
- [ ] **F3** Cockpit por-grupo (00122; scheduled_by_group/edit_message/reschedule/pause-por-grupo via paused_at)
- [ ] **F4** Pipeline de mídia (00120+00121; persistRepMedia, recent-media, runners mandam attachments, materializer copia media_id; áudio .wav + transcode)
- [ ] **F5** Recorrência por-grupo + anti-contaminação (not_contains @g.us lead-facing) + retirada do H40 + paridade + reescrever test-group-campaign.ts

## Probes ao vivo (precisam do "pode" do Pedro — mandam msg real)
- [ ] `probe-group-contacts-live.ts` (read-only — pode rodar)
- [ ] `probe-rep-audio-outbound.ts` (.wav — manda áudio real)
- [ ] `e2e-group-v2-live.ts` (manda texto/anexo real no grupo do Matheus)

## Notas de verificação
- F0 location-sync: ✅ `RkFnbOYKJvJfBEaU1ycO` está em `locations` (company `TdmQMjj86Y3LgppiB96K`, tz America/New_York) → envio não falha por sync.
- Última migration real antes do build: `00118`.
