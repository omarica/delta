// Shared hygiene for text that came from the internet (posts, READMEs, release notes, HN titles, plugin descriptions).
// Delta prints this text into output that an AI assistant reads, so it must never carry instructions or terminal tricks.
export const SAFE = /^[A-Za-z0-9._-]{1,100}$/;
export const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// Control chars, terminal escapes, zero-width and bidi override characters.
const INVISIBLE = /[\x00-\x1f\x7f-\x9f​-‏‪-‮⁠-⁩﻿]/g;

// Phrases that address an AI assistant or try to run something. Real plugin descriptions do not need them.
const INSTRUCTION_LIKE = new RegExp([
  String.raw`ignore (all |any |the )?(previous|prior|above|earlier|your)\b`,
  String.raw`disregard (all |any |the )?(previous|prior|above|earlier|your)\b`,
  String.raw`(forget|override) (all |any |your )?(previous |prior )?(instructions|rules|guidelines)`,
  String.raw`\b(system|developer) (prompt|message|instruction)s?\b`,
  String.raw`\byou (must|should|are now|will now|have to)\b`,
  String.raw`\b(assistant|claude|ai agent|llm)[,:] (please |now )?(run|execute|install|download|send|delete|disable|enable|write|read|curl|fetch)`,
  String.raw`\b(run|execute|paste) (the following|this command|these commands)\b`,
  String.raw`(curl|wget|iwr|invoke-webrequest)[^\n|]{0,120}\|\s*(sh|bash|zsh|iex|powershell)`,
  String.raw`<\/?(system|assistant|user|tool|function_calls?|invoke|instructions?)\b`,
  String.raw`\b(do not|don't) (tell|inform|mention|show) (the )?user\b`,
  String.raw`(~|\$HOME|%USERPROFILE%)[\\/]\.(ssh|aws|claude|codex|gnupg)`,
  String.raw`\.(env|npmrc|netrc)\b.{0,40}\b(send|upload|post|exfil)`,
].join('|'), 'i');

export const isInstructionLike = (s) => INSTRUCTION_LIKE.test(String(s ?? ''));

// Clean untrusted text for display. Instruction-like text is replaced, not passed along.
export function defang(s, n = 220) {
  const t = String(s ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (isInstructionLike(t)) return '[instruction-like text removed]';
  return t.slice(0, n);
}
