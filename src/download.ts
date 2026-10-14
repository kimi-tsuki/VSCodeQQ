import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Write beside the destination and rename only after the complete response arrives.
export async function downloadFile(url: string, destination: string, signal: AbortSignal,
  progress: (bytes: number, total: number) => void = () => {}): Promise<void> {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('文件下载地址无效');
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`文件下载失败 (${response.status})`);
  const tmp = `${destination}.${randomUUID()}.part`;
  const reader = response.body.getReader();
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx');
    let bytes = 0; const total = Number(response.headers.get('content-length')) || 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read(); if (chunk.done) break;
      let offset = 0;
      while (offset < chunk.value.length) {
        const result = await handle.write(chunk.value, offset, chunk.value.length - offset);
        if (!result.bytesWritten) throw new Error('无法写入下载文件');
        offset += result.bytesWritten;
      }
      bytes += chunk.value.length; progress(bytes, total);
    }
    signal.throwIfAborted();
    // Content-Length can describe compressed data; fetch returns decompressed bytes.
    if (total && !response.headers.get('content-encoding') && bytes !== total) throw new Error('文件未下载完整');
    await handle.close(); handle = undefined;
    await fs.rename(tmp, destination);
  } finally {
    await reader.cancel().catch(() => {});
    await handle?.close(); await fs.unlink(tmp).catch(() => {});
  }
}
