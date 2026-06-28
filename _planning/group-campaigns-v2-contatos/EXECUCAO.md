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
- [ ] **F1** Detector + descoberta + cache + envio de texto via GHL
  - [x] F1.1 `group-contacts/detector.ts` (puro) + `scripts/test-group-detector.ts`
  - [ ] F1.2 migration 00119 (group_contacts + is_group)
  - [ ] F1.3 `group-contacts/sync.ts` (descoberta `email contains @g.us` + detector + upsert + auto-heal locations) + cache
  - [ ] F1.4 rewire `tools/group-campaigns.ts` (list_groups←cache, resolveGroupTargets→contact_id real, schedule grava contact_id real + is_group)
  - [ ] F1.5 rewire `bulk-message-runner.ts` (deletar sendToGroup; pular opt-out/DND/assign por is_group; sem ramo de envio)
  - [ ] F1.6 flag `isGroupCampaignsV2Enabled` + caps enforçados em config.ts
  - [ ] F1.7 testes smoke (executeTool) + tsc/build + review adversarial
- [ ] **F2** Blindagem inbound (gate @g.us no webhook) + caps anti-ban enforçados + Termos ponto 3
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
