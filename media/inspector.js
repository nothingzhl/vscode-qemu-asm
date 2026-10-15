(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const tabs = ['memory', 'gdt', 'idt'];
  let state;
  const hex = (number, width = 8) => typeof number === 'number' ? `0x${number.toString(16).toUpperCase().padStart(width, '0')}` : '—';
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const cell = (row, text, className) => { const td = element('td', text, className); row.appendChild(td); return td; };
  const post = (type, detail = {}) => vscode.postMessage({ type, ...detail });
  const configure = form => post('configure', { form });
  const notify = text => { $('notice').textContent = text; $('notice').hidden = !text; };
  for (let index = 0; index < 16; index += 1) {
    const th = element('th', index.toString(16).toUpperCase().padStart(2, '0')); th.scope = 'col'; $('hex-head').appendChild(th);
  }
  $('hex-head').appendChild(element('th', 'ASCII'));

  function renderMemory(data) {
    const body = $('memory-body'); body.replaceChildren();
    $('memory-range').textContent = data ? `${hex(data.address)} — ${hex(data.address + Math.max(0, data.bytes.length - 1))}` : '';
    if (!data) return;
    for (let offset = 0; offset < data.bytes.length; offset += 16) {
      const row = element('tr');
      cell(row, hex(data.address + offset));
      const ascii = element('td');
      for (let index = 0; index < 16; index += 1) {
        const position = offset + index; const byte = data.bytes[position];
        const changed = data.changed[position];
        const byteCell = cell(row, byte === undefined ? '' : byte.toString(16).toUpperCase().padStart(2, '0'), changed ? 'byte changed' : 'byte');
        if (byte !== undefined) {
          byteCell.title = `${hex(data.address + position)} · ${byte}${changed ? ' · 字节已变化' : ''}`;
          const character = element('span', byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.', changed ? 'ascii-byte changed' : 'ascii-byte');
          ascii.appendChild(character);
        }
      }
      row.appendChild(ascii); body.appendChild(row);
    }
  }
  function renderDescriptors(data, tab) {
    const gdt = tab === 'gdt'; const ivt = data?.format === 'ivt';
    $('descriptor-title').textContent = gdt ? '全局描述符表 GDT' : ivt ? '实模式中断向量表 IVT' : '中断描述符表 IDT';
    $('descriptor-view').setAttribute('aria-labelledby', `tab-${tab}`);
    $('descriptor-hint').textContent = gdt ? '段寄存器使用 CPU 缓存的描述符；修改 GDT 后需重新加载段寄存器。'
      : ivt ? '实模式中断入口由 16 位段值和偏移组成；切入保护模式后使用 IDT 门描述符。' : '门描述符指定目标段与入口偏移；P 为存在位，DPL 为访问特权级。';
    $('table-meta').textContent = data ? `基址 ${hex(data.base)} · 界限 ${hex(data.limit, 4)}` : '';
    $('table-page').textContent = data ? `${data.entries.length ? data.start : 0}–${data.entries.length ? data.start + data.entries.length - 1 : 0} / ${data.totalEntries} 项` : '';
    const warnings = data?.warnings ?? [];
    $('table-warnings').textContent = warnings.join('\n'); $('table-warnings').hidden = !warnings.length;
    const head = $('descriptor-head'); head.replaceChildren();
    const names = gdt ? ['索引 / 选择子', '类型', '基址', '有效界限', 'P', 'DPL', 'D/B → 位宽', 'G', '权限 / 缓存提示']
      : ivt ? ['向量', '类型', '段值', '入口偏移', '入口线性地址', '提示'] : ['向量', '门类型', '目标选择子', '入口偏移', 'P', 'DPL', '位宽', '提示'];
    for (const name of names) { const th = element('th', name); th.scope = 'col'; head.appendChild(th); }
    const body = $('descriptor-body'); body.replaceChildren();
    for (const entry of data?.entries ?? []) {
      const row = element('tr');
      const notes = [...(entry.warnings ?? []), ...(entry.cacheWarnings ?? [])];
      if (notes.length) row.className = 'row-warning';
      row.title = `地址 ${hex(entry.address)} · 原始字节 ${entry.raw}`;
      const identity = cell(row, gdt ? `${entry.index} / ${hex(entry.index * 8, 4)}` : `${entry.index} / ${hex(entry.index, 2)}`);
      if (entry.registers?.length) {
        const tags = element('span', undefined, 'tags');
        for (const name of entry.registers) tags.appendChild(element('span', name, 'tag'));
        identity.appendChild(tags);
      }
      cell(row, entry.type, 'type-cell');
      if (gdt) {
        cell(row, hex(entry.base)); cell(row, hex(entry.effectiveLimit)); cell(row, entry.present ? '1' : '0');
        cell(row, entry.dpl); cell(row, entry.defaultBits === undefined ? '—' : `${entry.defaultBits === 32 ? 1 : 0} → ${entry.defaultBits}`); cell(row, entry.granularity === undefined ? '—' : entry.granularity ? '4 KiB' : '字节');
        const access = [];
        if (entry.readable) access.push('可读'); if (entry.writable) access.push('可写');
        if (entry.targetSelector !== undefined) access.push(`目标 ${hex(entry.targetSelector, 4)}${entry.offset === undefined ? '' : `:${hex(entry.offset, entry.gateBits === 16 ? 4 : 8)}`}`);
        if (entry.parameterCount !== undefined) access.push(`参数 ${entry.parameterCount}`);
        if (entry.conforming) access.push('一致段'); if (entry.expandDown) access.push('向下扩展'); if (entry.accessed) access.push('已访问');
        cell(row, [...access, ...notes].join(' · ') || '—', 'type-cell');
      } else {
        cell(row, hex(entry.selector, 4)); cell(row, hex(entry.offset, entry.gateBits === 16 || ivt ? 4 : 8));
        if (ivt) { cell(row, hex((entry.selector ?? 0) * 16 + (entry.offset ?? 0))); cell(row, notes.join(' · ') || '—', 'type-cell'); }
        else { cell(row, entry.present ? '1' : '0'); cell(row, entry.dpl); cell(row, entry.gateBits ?? '—'); cell(row, notes.join(' · ') || '—', 'type-cell'); }
      }
      body.appendChild(row);
    }
  }
  function render(snapshot) {
    const previousAddress = state?.form.address;
    state = snapshot;
    notify('');
    const { form } = snapshot; const memory = form.tab === 'memory';
    for (const tab of tabs) {
      const selected = tab === form.tab;
      $(`tab-${tab}`).setAttribute('aria-selected', String(selected)); $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
    }
    $('memory-view').hidden = !memory; $('descriptor-view').hidden = memory;
    if (document.activeElement !== $('address') || previousAddress !== form.address) $('address').value = hex(form.address);
    $('follow').value = form.follow;
    const canRead = snapshot.status === 'stopped';
    $('status').textContent = snapshot.message; $('status-dot').className = `dot ${snapshot.status}`;
    document.body.classList.toggle('stale', snapshot.stale);
    const data = memory ? snapshot.memory : snapshot[form.tab];
    $('stale').hidden = !snapshot.stale || !data;
    $('refresh').disabled = !canRead || snapshot.busy;
    $('address').disabled = !canRead; $('go').disabled = !canRead || snapshot.busy; $('follow').disabled = !canRead;
    const memoryAddress = snapshot.memory?.address ?? form.address;
    $('memory-prev').disabled = !canRead || snapshot.busy || memoryAddress === 0;
    $('memory-next').disabled = !canRead || snapshot.busy || memoryAddress >= 0xffffff00;
    const table = memory ? undefined : snapshot[form.tab];
    $('descriptor-prev').disabled = !canRead || snapshot.busy || (table?.start ?? 0) === 0;
    $('descriptor-next').disabled = !canRead || snapshot.busy || !table || table.start + table.count >= table.totalEntries;
    $('empty').hidden = Boolean(data);
    if (memory) renderMemory(snapshot.memory); else renderDescriptors(table, form.tab);
    vscode.setState({ form: { ...form } });
  }
  tabs.forEach((tab, index) => {
    $(`tab-${tab}`).addEventListener('click', () => configure({ tab }));
    $(`tab-${tab}`).addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault(); $(`tab-${tabs[next]}`).focus(); configure({ tab: tabs[next] });
    });
  });
  $('address-form').addEventListener('submit', event => { event.preventDefault(); post('address', { address: $('address').value }); });
  $('follow').addEventListener('change', () => configure({ follow: $('follow').value }));
  $('refresh').addEventListener('click', () => post('refresh'));
  for (const prefix of ['memory', 'descriptor']) {
    $(`${prefix}-prev`).addEventListener('click', () => post('navigate', { direction: -1 }));
    $(`${prefix}-next`).addEventListener('click', () => post('navigate', { direction: 1 }));
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'snapshot') render(message);
    else if (message.type === 'notice') notify(message.message);
  });
  const persisted = vscode.getState();
  post('ready', { form: persisted && typeof persisted === 'object' ? persisted.form : undefined });
})();
