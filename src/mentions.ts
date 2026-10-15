import { inline } from './model';

export const mentionPattern = /\[@:[^\]\r\n]*\]|@\[(\d+)\]/g;
export const mentionLabel = (name: string): string => inline(name).replace(/\[/g, '［').replace(/\]/g, '］').trim();
export const mentionText = (name: string): string => `[@:${mentionLabel(name)}]`;
export interface DraftMention { qq: string; text: string; }

// Display names are editable and non-unique. Only saved bindings or legacy
// numeric placeholders can create an actual OneBot at segment.
export function draftMentions(text: string, bindings: Record<string, string> = {}): (string | DraftMention)[] {
  const parts: (string | DraftMention)[] = []; let offset = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const qq = match[1] || (Object.hasOwn(bindings, match[0]) ? bindings[match[0]] : undefined);
    if (!qq || !/^(?:\d+|all)$/.test(qq)) throw new Error(`${match[0]} 没有对应群成员，请重新选择 @ 成员或删除占位符`);
    if (match.index! > offset) parts.push(text.slice(offset, match.index));
    parts.push({ qq, text: match[0] }); offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

export function restoredMentions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  return Object.fromEntries(Object.entries(value).filter(([token, qq]) =>
    /^\[@:[^\]\r\n]+\]$/.test(token) && typeof qq === 'string' && /^(?:\d+|all)$/.test(qq)));
}
