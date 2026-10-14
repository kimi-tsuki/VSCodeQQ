(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let busy = true;
  $('fields').disabled = true;
  const send = action => {
    if (busy) return;
    if (!['import', 'cleanCache'].includes(action) && !$('settings').reportValidity()) return;
    busy = true; $('fields').disabled = true; $('result').className = '';
    $('result').textContent = action === 'test' ? '正在测试连接…' : action === 'import' ? '请选择配置文件…' : '正在保存…';
    vscode.postMessage({ action, historyCount: Number($('historyCount').value), messageLimit: Number($('messageLimit').value), cacheRetentionDays: Number($('cacheRetentionDays').value), notifications: $('notifications').value, mentionColor: $('mentionColor').value, replyColor: $('replyColor').value, url: $('url').value, token: $('token').value, clearToken: $('clearToken').checked, autoConnect: $('autoConnect').checked });
  };
  $('settings').addEventListener('submit', event => { event.preventDefault(); send('connect'); });
  for (const action of ['save', 'test', 'import', 'cleanCache']) $(action).addEventListener('click', () => send(action));
  $('clearToken').addEventListener('change', () => { $('token').disabled = $('clearToken').checked; });
  window.addEventListener('message', event => {
    const data = event.data;
    if (data.state) {
      for (const key of ['historyCount', 'messageLimit', 'cacheRetentionDays', 'notifications', 'mentionColor', 'replyColor']) $(key).value = data.state[key];
      $('cacheInfo').textContent = `当前账号附件缓存：${data.state.cache.count} 个，${(data.state.cache.bytes / 1048576).toFixed(1)} MB`;
      $('url').value = data.state.url; $('autoConnect').checked = data.state.autoConnect;
      $('token').value = ''; $('token').placeholder = data.state.hasToken ? '已保存 Token；留空保持不变' : '未启用鉴权可留空';
      $('clearToken').checked = false; $('token').disabled = false;
    }
    $('result').textContent = data.error || data.message || '设置已就绪。';
    $('result').className = data.error ? 'error' : '';
    busy = false; $('fields').disabled = false;
  });
  vscode.postMessage({ action: 'ready' });
})();
