import * as vscode from 'vscode';
import { configuredCodeLanguage } from './configuration';

export class SettingsTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  status = '未连接';
  constructor(private connected: () => boolean) {}
  refresh(): void { this.emitter.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    if (parent) return [];
    const row = (id: string, label: string, icon: string, command: string, description?: string) => {
      const item = new vscode.TreeItem(label);
      item.id = id; item.iconPath = new vscode.ThemeIcon(icon); item.description = description;
      item.command = { command, title: label }; return item;
    };
    const connected = this.connected();
    const language = configuredCodeLanguage();
    const labels = { c: 'C', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', dart: 'Dart', kotlin: 'Kotlin', java: 'Java', swift: 'Swift' };
    return [
      row('connection', '连接设置', 'plug', 'qq.configure', this.status),
      row('connect', connected ? '重新连接' : '连接 NapCat', 'debug-restart', 'qq.connect'),
      ...(connected ? [row('disconnect', '断开连接', 'debug-disconnect', 'qq.disconnect')] : []),
      row('language', '代码风格', 'code', 'qq.chooseCodeLanguage', labels[language]),
      row('autoConnect', '自动连接', 'sync', 'qq.toggleAutoConnect', vscode.workspace.getConfiguration('qq').get('autoConnect', true) ? '开启' : '关闭'),
      row('settings', '全部设置', 'settings-gear', 'qq.configure')
    ];
  }
  dispose(): void { this.emitter.dispose(); }
}
