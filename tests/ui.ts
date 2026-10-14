import { WebSocket } from 'ws';

// Only the isolated extension-test window exposes this local DevTools port.
export class TestUI {
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private socket: WebSocket) {
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString()), pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result);
    });
  }
  static async connect(): Promise<TestUI> {
    const pages = await (await fetch('http://127.0.0.1:19222/json/list')).json() as any[];
    const page = pages.find(p => p.type === 'page' && p.url.includes('workbench'));
    if (!page) throw new Error('未找到独立测试窗口');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return new TestUI(socket);
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`UI 验证超时：${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('测试窗口 DOM 检查失败');
    return result.result.value;
  }
  async enter(modifiers = 0): Promise<void> {
    await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
  }
  async waitFor(expression: string): Promise<any> {
    for (let i = 0; i < 60; i++) {
      const value = await this.evaluate(expression); if (value) return value;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('等待 UI 状态超时');
  }
  close(): void { this.socket.close(); for (const p of this.pending.values()) clearTimeout(p.timer); }
}
