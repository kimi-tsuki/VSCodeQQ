import { chatSettings, languageLabels, validateChatSettings } from './settingsSchema';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Configuration, validateUrl } from './configuration';
import { OneBotClient } from './onebot';
import { codeLanguages, isCodeLanguage } from './codeStyle';

export class ConnectionSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private probe?: OneBotClient;
  constructor(private context: vscode.ExtensionContext, private config: Configuration, private connect: () => Promise<void>, private cacheInfo: () => Promise<{ bytes: number; count: number }>, private cleanCache: () => Promise<number>) {}
  async state() {
    return { ...this.config.chatOptions(), cache: await this.cacheInfo(), url: this.config.url, hasToken: !!await this.config.token(), autoConnect: vscode.workspace.getConfiguration('qq').get('autoConnect', true) };
  }
  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('qq.connectionSettings', 'QQ · 连接设置', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'qq-chat.svg');
    const nonce = randomBytes(24).toString('hex');
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('settings.css')}"></head><body><main>
      <header><h1>QQ 连接设置</h1><p>连接 NapCat 的 OneBot v11 正向 WebSocket 服务。</p></header>
      <form id="settings"><fieldset id="fields"><legend>连接信息</legend>
      <label for="url">WebSocket 地址</label><input id="url" type="text" placeholder="ws://127.0.0.1:3001" spellcheck="false" required aria-describedby="urlHelp"><p class="help" id="urlHelp">本机一般使用 ws://127.0.0.1:3001，远程 NapCat 填写对应地址和端口。</p>
      <label for="token">Access Token</label><input id="token" type="password" autocomplete="new-password" placeholder="未启用鉴权可留空" aria-describedby="tokenHelp"><p class="help" id="tokenHelp">Token 保存在 VS Code 安全存储中，不写入 settings.json。</p>
      <label class="check"><input id="clearToken" type="checkbox">清除已保存的 Token</label>
      <label class="check"><input id="autoConnect" type="checkbox">打开 QQ 视图时自动连接</label>
      <hr><h2>聊天与提醒</h2>
      <label for="codeLanguage">代码语言风格</label><select id="codeLanguage" aria-describedby="codeLanguageHelp">${codeLanguages.map((value, i) => `<option value="${value}">${languageLabels[value]}${value === 'c' ? '（默认）' : ''}</option>`).join('')}</select><p class="help" id="codeLanguageHelp">仅改变聊天记录的代码显示风格；保存后立即生效，草稿和消息原文保持不变。</p>
      <label for="historyCount">首次加载历史条数</label><input id="historyCount" type="number" min="${chatSettings.historyCount.minimum}" max="${chatSettings.historyCount.maximum}" required>
      <label for="messageLimit">每个会话历史上限（未完成发送单独保留）</label><input id="messageLimit" type="number" min="${chatSettings.messageLimit.minimum}" max="${chatSettings.messageLimit.maximum}" required>
      <label for="notifications">弹窗提醒</label><select id="notifications"><option value="all">允许提醒的所有新消息</option><option value="mentions">仅 @我和回复我</option><option value="off">关闭弹窗（保留未读与高亮）</option></select>
      <label for="mentionColor">@我高亮颜色</label><input id="mentionColor" type="color">
      <label for="replyColor">回复我高亮颜色</label><input id="replyColor" type="color"><p class="help">使用淡色背景和左侧色条，同时 @我和回复我时优先显示 @我颜色。</p>
      <h2>附件缓存</h2><label for="cacheRetentionDays">无引用附件保留天数</label><input id="cacheRetentionDays" type="number" min="${chatSettings.cacheRetentionDays.minimum}" max="${chatSettings.cacheRetentionDays.maximum}" required>
      <p id="cacheInfo" class="help"></p><button type="button" id="cleanCache" class="secondary">清理无用附件缓存</button><p class="help">保护草稿、撤销记录、发送队列和历史图片；最近一小时导入的附件暂不清理。</p>
      <div class="actions"><button type="submit" id="connect">保存并连接</button><button type="button" id="save" class="secondary">仅保存</button><button type="button" id="test" class="secondary">测试连接</button></div>
      <div class="import"><button type="button" id="import" class="secondary">导入 tuiqq 配置</button><span class="help">选择现有的 config.json。</span></div>
      </fieldset></form><p id="result" role="status" aria-live="polite">正在读取设置…</p>
      <footer>测试连接使用临时连接，不会切换当前聊天账号，也不会发送 QQ 消息。</footer>
      </main><script nonce="${nonce}" src="${asset('settings.js')}"></script></body></html>`;
    const listener = panel.webview.onDidReceiveMessage(async data => {
      try { await panel.webview.postMessage(await this.handle(data)); }
      catch (error: any) { await panel.webview.postMessage({ error: error.message }); }
    });
    panel.onDidDispose(() => { listener.dispose(); this.probe?.dispose(); if (this.panel === panel) this.panel = undefined; });
  }
  async handle(data: any): Promise<any> {
    if (data?.action === 'ready') return { state: await this.state() };
    if (!['save', 'connect', 'test', 'import', 'cleanCache'].includes(data?.action)) throw new Error('未知设置操作');
    if (this.busy) throw new Error('请等待当前操作完成');
    this.busy = true;
    try {
      if (data.action === 'cleanCache') {
        const bytes = await this.cleanCache(); return { state: await this.state(), message: `已清理 ${(bytes / 1048576).toFixed(1)} MB 无用附件缓存。` };
      }
      if (data.action === 'import') {
        const imported = await this.config.import();
        return { state: await this.state(), message: imported ? '配置已导入，点击“保存并连接”应用。' : '已取消导入。' };
      }
      if (typeof data.url !== 'string' || typeof data.token !== 'string' || typeof data.autoConnect !== 'boolean' || typeof data.clearToken !== 'boolean') throw new Error('连接配置格式无效');
      if (data.codeLanguage !== undefined && !isCodeLanguage(data.codeLanguage)) throw new Error('代码语言风格无效');
      const url = data.url.trim(), invalid = validateUrl(url); if (invalid) throw new Error(invalid);
      const token = data.clearToken ? '' : data.token || undefined;
      if (data.action === 'test') {
        const probe = new OneBotClient(); this.probe = probe;
        try {
          await probe.connect(url, token ?? await this.config.token());
          const info = await probe.call('get_login_info', {}, 5000);
          if (!/^\d+$/.test(String(info?.user_id ?? ''))) throw new Error('NapCat 没有返回有效的登录账号');
          return { message: `连接成功：${String(info.nickname || 'QQ')}（${info.user_id}）` };
        } finally { probe.dispose(); if (this.probe === probe) this.probe = undefined; }
      }
      const updates = validateChatSettings(data);
      const settings = vscode.workspace.getConfiguration('qq');
      const keys = ['wsUrl', 'autoConnect', ...updates.map(([key]) => key)];
      const missing = keys.filter(key => settings.inspect(key)?.defaultValue === undefined);
      if (missing.length) throw new Error(`插件配置尚未加载（${missing.map(key => 'qq.' + key).join('、')}）。请执行 Developer: Reload Window（开发人员: 重新加载窗口），重新打开 QQ 设置后保存。本次未写入设置。`);
      await this.config.saveConnection(url, token, data.autoConnect);
      for (const [key, value] of updates) await vscode.workspace.getConfiguration('qq').update(key, value, vscode.ConfigurationTarget.Global);
      if (data.action === 'connect') {
        try { await this.connect(); }
        catch (error: any) { return { state: await this.state(), error: `配置已保存，但连接失败：${error.message}` }; }
      }
      return { state: await this.state(), message: data.action === 'connect' ? '配置已保存，QQ 已连接。' : '配置已保存；聊天设置已生效，连接参数在下次连接时应用。' };
    } finally { this.busy = false; }
  }
  dispose(): void { this.probe?.dispose(); this.panel?.dispose(); }
}
