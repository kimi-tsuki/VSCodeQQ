(() => {
  const api = acquireVsCodeApi();
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const pending = new Set();
  const edits = new Map();
  const panel = document.getElementById('emojiPanel');
  const favoriteGrid = document.getElementById('favoriteFaces');
  const previews = new Map();
  let faceCount = 48;
  let state = {}, composing = false;
  const token = () => `${state.account}:${state.key}`;
  const post = (type, more = {}) => api.postMessage({ type, account: state.account, key: state.key, replyId: state.replyId, ...more });
  const buttons = () => {
    send.disabled = !state.ready || !state.key || (!input.value.trim() && !(state.attachments || []).length) || pending.has(token());
    send.textContent = pending.has(token()) ? '发送中…' : '发送';
    document.getElementById('addImage').disabled = !state.key;
    document.getElementById('emojis').disabled = !state.key;
  };
  const draft = () => { const n = (edits.get(token()) || 0) + 1; edits.set(token(), n); post('draft', { text: input.value, editVersion: n }); };
  const submit = () => {
    if (send.disabled || composing) return;
    pending.add(token()); document.getElementById('error').textContent = '';
    post('send', { text: input.value }); buttons();
  };
  input.addEventListener('input', () => { draft(); buttons(); });
  input.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items || [])].filter(item => item.type.startsWith('image/'));
    if (!items.length || !state.key) return;
    e.preventDefault();
    const account = state.account, key = state.key;
    for (const item of items) {
      const file = item.getAsFile(); if (!file) continue;
      if (file.size > 16 * 1024 * 1024) { document.getElementById('error').textContent = '单张图片不能超过 16 MB'; continue; }
      const reader = new FileReader();
      reader.onload = () => api.postMessage({ type: 'pasteImage', account, key, base64: String(reader.result).split(',')[1] });
      reader.readAsDataURL(file);
    }
  });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submit(); } });
  input.addEventListener('focus', () => post('focus', { value: true }));
  input.addEventListener('blur', () => post('focus', { value: false }));
  send.addEventListener('click', submit);
  document.getElementById('cancel').addEventListener('click', () => post('cancelReply'));
  document.getElementById('addImage').addEventListener('click', () => post('pickImages'));
  const loadFaces = count => { faceCount = count; document.getElementById('favoriteStatus').textContent = '正在读取收藏表情…'; post('faces', { count }); };
  document.getElementById('emojis').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) loadFaces(48); });
  document.getElementById('reloadFaces').addEventListener('click', () => loadFaces(faceCount));
  document.getElementById('moreFaces').addEventListener('click', () => loadFaces(Math.min(500, faceCount + 48)));
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target); post('favoritePreview', { id: entry.target.dataset.id });
    }
  }, { root: favoriteGrid, rootMargin: '60px' });
  const renderAttachments = () => {
    const container = document.getElementById('attachments'); container.replaceChildren();
    for (const attachment of state.attachments || []) {
      const chip = document.createElement('span'); chip.className = 'attachment';
      const label = document.createElement('span'); label.textContent = `${attachment.kind === 'face' ? '表情' : '图片'}：${attachment.label}`;
      const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '移除附件';
      remove.addEventListener('click', () => post('removeAttachment', { id: attachment.id }));
      chip.append(label, remove); container.append(chip);
    }
  };
  window.addEventListener('message', e => {
    const data = e.data;
    if (data.type === 'state') {
      const changed = state.account !== data.account || state.key !== data.key;
      state = data;
      document.getElementById('target').textContent = data.name ? `发送到：${data.name}` : '从左侧选择会话';
      document.getElementById('status').textContent = data.ready ? '已连接' : '未连接 · 草稿已保留';
      if ((changed || data.editVersion >= (edits.get(token()) || 0)) && input.value !== data.text) input.value = data.text;
      input.disabled = !data.key;
      document.getElementById('reply').hidden = !data.replyId;
      document.getElementById('replyText').textContent = `回复：${data.replyPreview}`;
      if (changed) { document.getElementById('error').textContent = ''; panel.hidden = true; observer.disconnect(); }
      renderAttachments(); buttons();
    } else if (data.type === 'focusInput') input.focus();
    else if (data.type === 'showEmojis') { panel.hidden = false; loadFaces(48); }
    else if (data.type === 'sent') { pending.delete(`${data.account}:${data.key}`); buttons(); }
    else if (data.account === state.account && data.key === state.key) {
      if (data.type === 'error') { document.getElementById('error').textContent = data.message; document.getElementById('favoriteStatus').textContent = ''; }
      else if (data.type === 'basicFaces') {
        const grid = document.getElementById('basicFaces'); grid.replaceChildren();
        for (const face of data.faces) {
          const button = document.createElement('button'); button.textContent = `${face.icon} ${face.name}`; button.title = `QQ 表情 ${face.id}`;
          button.addEventListener('click', () => post('basicFace', { id: face.id })); grid.append(button);
        }
      } else if (data.type === 'favoriteFaces') {
        observer.disconnect(); previews.clear(); favoriteGrid.replaceChildren();
        document.getElementById('favoriteStatus').textContent = data.entries.length ? `已读取 ${data.entries.length} 个，点击加入待发送附件` : '账号暂无收藏表情';
        document.getElementById('moreFaces').hidden = !data.more;
        for (const entry of data.entries) {
          const button = document.createElement('button'); button.dataset.id = entry.id; button.title = entry.label;
          const image = document.createElement('img'); image.alt = entry.label; previews.set(entry.id, image); button.append(image);
          button.addEventListener('click', () => post('favoriteFace', { id: entry.id })); favoriteGrid.append(button); observer.observe(button);
        }
      } else if (data.type === 'favoritePreview' && data.src && previews.has(data.id)) previews.get(data.id).src = data.src;
    }
  });
  post('ready');
})();
