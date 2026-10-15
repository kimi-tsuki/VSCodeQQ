import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ChatTree } from './tree';
import { ChatStore } from './store';
import { allowsUnread } from './notifications';

// TreeView does not expose an embedded input. Keep filtering/sorting in ChatTree
// and use a small theme-aware view for a permanent search field.
export class ChatListView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private pendingFocus = false;
  constructor(private tree: ChatTree, private store: () => ChatStore | undefined, private filter: (query: string) => void) {
    this.subscriptions.push(tree.onDidChangeTreeData(() => this.update()));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    const messages = view.webview.onDidReceiveMessage(async data => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ready') {
        void view.webview.postMessage({ type: 'initialFilter', query: this.tree.filter }); this.update();
        if (this.pendingFocus) this.focusSearch();
        return;
      }
      if (data.type === 'focused') { this.pendingFocus = false; return; }
      if (data.type === 'filter' && typeof data.query === 'string') { this.filter(data.query.slice(0, 200)); return; }
      const store = this.store();
      if (!store || data.account !== store.selfId || typeof data.key !== 'string' || !store.chats.has(data.key)) return;
      const command = { open: 'qq.openChat', favorite: 'qq.toggleFavorite' }[data.type as string];
      if (command) await vscode.commands.executeCommand(command, data.key);
    });
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) this.update(); });
    const closed = view.onDidDispose(() => { messages.dispose(); visibility.dispose(); closed.dispose(); if (this.view === view) this.view = undefined; });
  }
  focusSearch(): void {
    this.pendingFocus = true;
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'focus' });
  }
  setFilter(query: string): void { void this.view?.webview.postMessage({ type: 'filter', query }); }
  private update(): void {
    if (!this.view?.visible) return;
    const store = this.store();
    const rows = this.tree.getChildren('').map(chat => ({
      key: chat.key, name: chat.name, id: chat.id, kind: chat.type === 'group' ? '群' : '友',
      search: `${chat.name} ${chat.remark ?? ''} ${chat.nickname ?? ''} ${chat.id}`.toLocaleLowerCase(),
      preview: chat.preview, favorite: !!store?.favorites.has(chat.key), unread: allowsUnread(chat) ? chat.unread : 0,
      mention: chat.mentioned, reply: chat.replied, muted: !allowsUnread(chat), tooltip: this.tree.getTreeItem(chat).tooltip
    }));
    void this.view.webview.postMessage({ type: 'rows', account: store?.selfId ?? '', rows });
  }
  private html(): string {
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
*{box-sizing:border-box}body{padding:0;margin:0;color:var(--vscode-sideBar-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}
.search{display:flex;gap:3px;flex-shrink:0;padding:6px 8px;background:var(--vscode-sideBar-background)}input{min-width:0;width:100%;height:26px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:3px 6px;font:inherit;outline:none}input:focus,button:focus-visible,.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}input::placeholder{color:var(--vscode-input-placeholderForeground)}
button{font:inherit;border:0;cursor:pointer;background:transparent;color:inherit;padding:3px 5px}button:hover{background:var(--vscode-toolbar-hoverBackground)}#results{overflow-y:auto;flex:1;min-height:0}.row{display:flex;align-items:center;gap:6px;padding:5px 8px;min-height:42px;cursor:pointer;outline:none}.row:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground)}.row.selected{background:var(--vscode-list-inactiveSelectionBackground)}.row:focus{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.kind{font-size:11px;opacity:.7}.text{flex:1;min-width:0}.name,.preview{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.preview{opacity:.7;font-size:11px;margin-top:2px}.count{border-radius:9px;padding:1px 5px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.favorite{opacity:0}.row:hover .favorite,.row:focus-within .favorite,.favorite.saved{opacity:1}#empty{padding:10px;opacity:.7}#empty:empty{display:none}#count{padding:0 8px 4px;font-size:11px;opacity:.65}::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background)}
</style></head><body data-section="${this.tree.section}"><div class="search"><input id="search" type="text" maxlength="200" aria-label="搜索${this.tree.section === 'favorites' ? '收藏' : '会话'}" placeholder="搜索名称、备注、号码" autocomplete="off"><button id="clear" title="清除搜索" aria-label="清除搜索">×</button></div><div id="count" role="status"></div><div id="empty"></div><div id="results" role="listbox" aria-label="${this.tree.section === 'favorites' ? '收藏' : '会话列表'}"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), input=document.getElementById('search'), results=document.getElementById('results');
let rows=[],account='',selected='',composing=false,touched=false;
input.value=vscode.getState()?.query||'';
function send(type,key){vscode.postMessage({type,key,account});}
function render(){
 const focused=results.contains(document.activeElement),scroll=results.scrollTop,terms=input.value.trim().toLocaleLowerCase().split(/\\s+/).filter(Boolean);
 const visible=rows.filter(row=>terms.every(term=>row.search.includes(term)));
 if(!visible.some(row=>row.key===selected))selected=visible[0]?.key||'';
 const fragment=document.createDocumentFragment();
 for(const row of visible){
  const item=document.createElement('div');item.className='row'+(row.key===selected?' selected':'');item.dataset.key=row.key;item.tabIndex=row.key===selected?0:-1;item.setAttribute('role','option');item.setAttribute('aria-selected',String(row.key===selected));item.title=row.tooltip||row.name;
  item.dataset.vscodeContext=JSON.stringify({webviewSection:'qq-chat-row',key:row.key,account,preventDefaultContextMenuItems:true});
  const kind=document.createElement('span');kind.className='kind';kind.textContent=row.kind;
  const text=document.createElement('div');text.className='text';const name=document.createElement('div');name.className='name';name.textContent=row.name;const preview=document.createElement('div');preview.className='preview';preview.textContent=(row.muted?'◦ ':'')+(row.preview||row.id);text.append(name,preview);item.append(kind,text);
  if(row.unread){const count=document.createElement('span');count.className='count';count.textContent=(row.mention?'@ ':row.reply?'↩ ':'')+(row.unread>99?'99+':row.unread);item.append(count);}
  const star=document.createElement('button');star.className='favorite'+(row.favorite?' saved':'');star.textContent=row.favorite?'★':'☆';star.title=row.favorite?'取消收藏':'收藏';star.setAttribute('aria-label',star.title);star.dataset.action='favorite';item.append(star);fragment.append(item);
 }
 results.replaceChildren(fragment);results.scrollTop=scroll;
 if(focused)[...results.children].find(row=>row.dataset.key===selected)?.focus({preventScroll:true});
 document.getElementById('empty').textContent=visible.length?'':input.value.trim()?'没有匹配的会话':account?'${this.tree.section === 'favorites' ? '右键会话或点击 ☆ 添加收藏' : '暂无会话，请在下方设置中连接 NapCat'}':'请在下方设置中连接 NapCat';
 document.getElementById('count').textContent=input.value.trim()?visible.length+' 个结果':'';
}
function filter(){touched=true;vscode.setState({query:input.value});render();vscode.postMessage({type:'filter',query:input.value});}
input.addEventListener('compositionstart',()=>composing=true);input.addEventListener('compositionend',()=>{composing=false;filter()});input.addEventListener('input',()=>{if(!composing)filter()});
document.getElementById('clear').onclick=()=>{input.value='';filter();input.focus()};
results.onclick=event=>{const row=event.target.closest('.row');if(!row)return;selected=row.dataset.key;send(event.target.closest('[data-action]')?'favorite':'open',selected)};
document.addEventListener('keydown',event=>{
 if(composing||event.isComposing)return;
 if((event.ctrlKey||event.metaKey)&&event.key==='f'){event.preventDefault();input.focus();input.select();return;}
 if(event.key==='Escape'){event.preventDefault();input.value='';filter();input.focus();return;}
 const items=[...results.children];let index=items.findIndex(row=>row.dataset.key===selected);
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();index=document.activeElement===input?(event.key==='ArrowDown'?0:items.length-1):Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));const row=items[index];if(row){selected=row.dataset.key;render();[...results.children][index].focus();}return;}
 if(event.key==='Enter'&&selected&&document.activeElement.tagName!=='BUTTON'){event.preventDefault();send('open',selected);}
});
window.addEventListener('message',({data})=>{if(data.type==='rows'){rows=data.rows;account=data.account;render()}else if(data.type==='filter'||(data.type==='initialFilter'&&!touched)){input.value=data.query;vscode.setState({query:input.value});render()}else if(data.type==='focus'){input.focus();input.select();vscode.postMessage({type:'focused'})}});
vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
  dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
