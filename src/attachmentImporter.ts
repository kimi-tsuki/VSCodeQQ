import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Attachment } from './model';
import { AttachmentFiles } from './attachments';
import { ChatStore } from './store';
interface Host {
  store?: ChatStore; attachments?: AttachmentFiles;
  attachToDraft(key: string, attachments: Attachment[]): Promise<void>;
}
export class AttachmentImporter {
  constructor(private host: Host) {}
  async selectImages(key: string): Promise<void> {
    const store = this.host.store;
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, title: '选择要发送的图片', filters: { '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] } });
    if (!uris?.length || store !== this.host.store) return;
    await this.stageImages(key, uris.map(uri => async () => {
      if ((await fs.stat(uri.fsPath)).size > 16 * 1024 * 1024) throw new Error('单张图片不能超过 16 MB');
      return { bytes: await fs.readFile(uri.fsPath), label: path.basename(uri.fsPath) };
    }));
  }
  async pasteImage(key: string, base64: string): Promise<void> {
    if (base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('剪贴板图片过大或格式无效');
    await this.stageImages(key, [async () => ({ bytes: Buffer.from(base64, 'base64'), label: '粘贴的图片' })]);
  }
  private async stageImages(key: string, sources: (() => Promise<{bytes: Buffer; label: string}>)[]): Promise<void> {
    const store = this.host.store, files = this.host.attachments;
    if (!store?.chats.has(key) || !files) return;
    if (sources.length > 8) throw new Error('每条消息最多附带 8 个图片或表情');
    const staged: Attachment[] = [];
    try {
      for (const source of sources) { const {bytes, label} = await source(); staged.push(await files.stage(bytes, label)); }
      if (store !== this.host.store) throw new Error('账号已切换，请重新导入');
      await this.host.attachToDraft(key, staged);
    } catch (error) { await files.discard(staged); throw error; }
  }
}
