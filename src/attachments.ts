import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachment } from './model';
import { imageExtension } from './media';

export const basicFaces = [
  { id: '14', name: '微笑', icon: '🙂' }, { id: '1', name: '撇嘴', icon: '😒' },
  { id: '4', name: '得意', icon: '😎' }, { id: '5', name: '流泪', icon: '😢' },
  { id: '6', name: '害羞', icon: '😊' }, { id: '9', name: '大哭', icon: '😭' },
  { id: '13', name: '呲牙', icon: '😁' }, { id: '20', name: '偷笑', icon: '🤭' },
  { id: '32', name: '疑问', icon: '❓' }, { id: '66', name: '爱心', icon: '❤️' },
  { id: '76', name: '赞', icon: '👍' }, { id: '78', name: '握手', icon: '🤝' },
  { id: '79', name: '胜利', icon: '✌️' }, { id: '99', name: '鼓掌', icon: '👏' }
];
export class AttachmentFiles {
  constructor(readonly folder: string) {}
  async stage(bytes: Buffer, label: string, sticker = false): Promise<Attachment> {
    if (bytes.length > 16 * 1024 * 1024) throw new Error('单张图片不能超过 16 MB');
    const ext = imageExtension(bytes); if (!ext) throw new Error('请选择 PNG、JPEG、GIF、WebP 或 BMP 图片');
    await fs.mkdir(this.folder, { recursive: true });
    const id = randomUUID(), file = path.join(this.folder, id + ext);
    await fs.writeFile(file, bytes);
    return { id, kind: 'image', label, file, sticker };
  }
  async stageFile(bytes: Buffer, name: string): Promise<Attachment> {
    const label = name.split(/[\\/]/).pop()?.replace(/[\r\n\0]/g, ' ') || '文件';
    const id = randomUUID(), file = path.join(this.folder, id + '.attachment');
    await fs.mkdir(this.folder, { recursive: true });
    await fs.writeFile(file, bytes);
    return { id, kind: 'file', label, file, size: bytes.length };
  }
  async stageFilePath(source: string, name: string): Promise<Attachment> {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error('请拖入文件，文件夹请先压缩');
    if (!stat.size) throw new Error('不能发送空文件');
    const id = randomUUID(), file = path.join(this.folder, id + '.attachment');
    await fs.mkdir(this.folder, { recursive: true });
    await fs.copyFile(source, file);
    const size = (await fs.stat(file)).size;
    return { id, kind: 'file', label: name, file, size };
  }
  async filePath(attachment: Attachment): Promise<string> {
    if (!attachment.file || path.dirname(path.resolve(attachment.file)) !== path.resolve(this.folder)) throw new Error('附件路径无效');
    if (!(await fs.stat(attachment.file)).isFile()) throw new Error('附件缓存已失效');
    return attachment.file;
  }
  async read(attachment: Attachment): Promise<Buffer> {
    if (!attachment.file || path.dirname(path.resolve(attachment.file)) !== path.resolve(this.folder)) throw new Error('附件路径无效');
    const stat = await fs.stat(attachment.file);
    if (stat.size > 16 * 1024 * 1024) throw new Error('附件过大');
    return fs.readFile(attachment.file);
  }
  async segments(attachments: Attachment[]): Promise<unknown[]> {
    if (attachments.length > 8) throw new Error('附件数量超过上限');
    const segments: unknown[] = []; let size = 0;
    for (const attachment of attachments) {
      if (attachment.kind === 'face') {
        if (!basicFaces.some(face => face.id === attachment.faceId)) throw new Error('无效的 QQ 表情');
        segments.push({ type: 'face', data: { id: attachment.faceId } });
      } else {
        if (attachment.kind === 'file') throw new Error('文件必须通过文件上传接口发送');
        const bytes = await this.read(attachment); size += bytes.length;
        if (size > 16 * 1024 * 1024) throw new Error('单条消息的图片总大小不能超过 16 MB');
        segments.push({ type: 'image', data: { file: `base64://${bytes.toString('base64')}`, ...(attachment.sticker ? { sub_type: 1 } : {}) } });
      }
    }
    return segments;
  }
}
