/**
 * contact-resolver (H45, 2026-06-26) — resolução de contato robusta (herança de contexto +
 * busca fuzzy com score). Resolve o bug sistêmico "não achei" (45/sem, 14 reps). Ver
 * _planning/sparkbot-contact-resolution-2026-06/.
 */
export { deburr, nameScore, nameTokens, dice, phoneDigits, phoneSuffixScore, looksLikePhone } from "./normalize";
export { resolveContact, type ResolveResult, type ResolvedContact } from "./resolve";
export {
  getActiveContactContext,
  renderContactInFocusBlock,
  recordRecentContact,
  readRecentContacts,
  type ActiveContactContext,
  type FocusContact,
} from "./active-contact";
