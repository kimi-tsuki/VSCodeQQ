import { mentionText } from './mentions';
import { Attachment, Draft, emptyDraft, attachmentPattern, inline } from './model';

export class DraftService {
  readonly values = new Map<string, Draft>();
  attachmentSerial = 0;
  constructor(private changed: (key: string, replyChanged: boolean) => void) {}
  draft(key: string): Draft { return this.values.get(key) ?? emptyDraft(); }
  setDraft(key: string, text: string, replyId?: string, attachments = this.draft(key).attachments): Draft {
    const replyChanged = this.draft(key).replyId !== replyId;
    const next = { ...this.draft(key), text, replyId, attachments, version: this.draft(key).version + 1 };
    this.values.set(key, next); this.changed(key, replyChanged); return next;
  }
  reserveMention(key: string, qq: string, name: string): string {
    if (!/^(?:\d+|all)$/.test(qq)) throw new Error('无效的群成员');
    const draft = this.draft(key), mentions = draft.mentions ?? {};
    const label = name || (qq === 'all' ? '全体成员' : qq);
    let token = mentionText(label), number = 2;
    if (mentions[token] && mentions[token] !== qq) token = mentionText(`${label} (${qq})`);
    while (mentions[token] && mentions[token] !== qq) token = mentionText(`${label} (${qq}, ${number++})`);
    // Reserve without changing the text or emitting editor updates while a
    // completion menu is open. The accepted edit persists the binding with it.
    mentions[token] = qq;
    this.values.set(key, { ...draft, mentions });
    return token;
  }
  clearDraftIfVersion(key: string, version: number): boolean {
    if (this.draft(key).version !== version) return false;
    this.setDraft(key, '', undefined, []); return true;
  }
  completeSend(key: string, captured: Draft): boolean {
    if (this.clearDraftIfVersion(key, captured.version)) return true;
    const sent = new Set(captured.attachments.map(a => a.id));
    const current = this.draft(key);
    const keep = (a: Attachment) => !sent.has(a.id) || !!(a.placeholder && current.text.includes(a.placeholder));
    if (current.attachments.some(a => !keep(a))) this.setDraft(key, current.text, current.replyId, current.attachments.filter(keep));
    return false;
  }
  attach(key: string, attachments: Attachment[]): void {
    const prepared = this.prepareAttachments(key, attachments);
    const draft = this.draft(key);
    this.setDraft(key, draft.text + prepared.map(a => a.placeholder).join(''), draft.replyId);
  }
  prepareAttachments(key: string, attachments: Attachment[]): Attachment[] {
    const draft = this.draft(key);
    const used = draft.text.match(attachmentPattern)?.length ?? 0;
    if (used + attachments.length > 8) throw new Error('每条消息最多附带 8 个附件');
    const tokens = new Set(draft.attachments.map(a => a.placeholder));
    const prepared = attachments.map(a => {
      let placeholder: string;
      if (a.kind === 'file') {
        const name = inline(a.label).replace(/\[/g, '［').replace(/\]/g, '］');
        placeholder = `[文件:${name}]`; let number = 2;
        while (tokens.has(placeholder)) placeholder = `[文件:${name} (${number++})]`;
      } else placeholder = `[${a.kind === 'image' ? '图片' : '表情'}:${++this.attachmentSerial}]`;
      tokens.add(placeholder); return { ...a, placeholder };
    });
    // Retain a small number of removed tokens so undo/redo can restore their attachments.
    const retained = draft.attachments.filter(a => !a.placeholder || draft.text.includes(a.placeholder));
    const orphaned = draft.attachments.filter(a => a.placeholder && !draft.text.includes(a.placeholder)).slice(-48);
    this.setDraft(key, draft.text, draft.replyId, [...retained, ...orphaned, ...prepared]);
    return prepared;
  }
  removeAttachment(key: string, id: string): void {
    const draft = this.draft(key), attachment = draft.attachments.find(a => a.id === id);
    const text = attachment?.placeholder ? draft.text.split(attachment.placeholder).join('') : draft.text;
    this.setDraft(key, text, draft.replyId, draft.attachments.filter(a => a.id !== id));
  }
}
