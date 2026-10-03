// Shared hygiene for text that came from the internet (posts, READMEs, release notes, HN titles, plugin descriptions).
// Delta prints this text into output that an AI assistant reads, so it must never carry instructions or terminal tricks.
export const SAFE = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}$/;
export const SAFE_REPO = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}$/;

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

// Best-effort only: a pattern list can never catch every phrasing. It is one layer; the others are that text is data in a
// labelled section, install commands are rebuilt locally, and nothing is ever installed without the user's explicit yes.
// To defeat spacing / fullwidth / zero-width tricks we test the NFKC-normalised text AND a letters-only compact form.
const COMPACT = ['ignorepreviousinstruction', 'ignoreallpreviousinstruction', 'ignoreprevious', 'ignoreprior', 'ignoretheabove', 'ignoreyourinstruction', 'disregardprevious', 'disregardall', 'disregardyour',
  'forgetpreviousinstruction', 'forgetyourinstruction', 'overrideyourinstruction', 'systemprompt', 'developermessage', 'youmustrun', 'youmustinstall', 'youmustexecute', 'donottelltheuser', 'donttelltheuser',
  'donotmentiontotheuser', 'newinstructions', 'curlhttp', 'wgethttp', 'invokewebrequest', 'pipetosh', 'pipetobash', 'sshkey', 'awscredentials'];
const normalise = (s) => String(s ?? '').normalize('NFKC').replace(INVISIBLE, ' ');
export const isInstructionLike = (s) => {
  const t = normalise(s);
  if (INSTRUCTION_LIKE.test(t)) return true;
  const compact = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  return COMPACT.some((p) => compact.includes(p));
};

// Only plain https links to a short allowlist of hosts, with no userinfo, port or punycode.
const HOSTS = ['github.com', 'news.ycombinator.com', 'www.youtube.com', 'youtube.com', 'www.tiktok.com', 'www.instagram.com', 'www.reddit.com', 'reddit.com', 'x.com', 'docs.anthropic.com', 'code.claude.com'];
export function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && !x.username && !x.password && !x.port && !x.hostname.includes('xn--') && HOSTS.includes(x.hostname.toLowerCase()) && /^[\x21-\x7e]+$/.test(x.href);
  } catch { return false; }
}

// Clean untrusted text for display. Instruction-like text is replaced, not passed along.
export function defang(s, n = 220) {
  const t = normalise(s).replace(/\s+/g, ' ').trim();
  if (isInstructionLike(t)) return '[instruction-like text removed]';
  return t.slice(0, n);
}
