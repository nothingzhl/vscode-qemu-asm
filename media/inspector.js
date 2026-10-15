(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const tabs = ['memory', 'disassembly', 'watchpoints', 'paging', 'gdt', 'idt'];
  let state;
  const hex = (number, width = 8) => typeof number === 'number' ? `0x${number.toString(16).toUpperCase().padStart(width, '0')}` : '—';
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const cell = (row, text, className) => { const td = element('td', text, className); row.appendChild(td); return td; };
  const post = (type, detail = {}) => vscode.postMessage({ type, ...(['instructionBreakpoint', 'watchpoint'].includes(type) ? { generation: state?.generation, sessionId: state?.sessionId } : {}), ...detail });
  const configure = form => post('configure', { form });
  const notify = text => { $('notice').textContent = text; $('notice').hidden = !text; };
  for (let index = 0; index < 16; index += 1) {
    const th = element('th', index.toString(16).toUpperCase().padStart(2, '0')); th.scope = 'col'; $('hex-head').appendChild(th);
  }
  $('hex-head').appendChild(element('th', 'ASCII'));

  function renderMemory(data) {
    const body = $('memory-body'); body.replaceChildren();
    $('memory-context').textContent = data ? `${data.space === 'physical' ? '物理地址' : data.pagingEnabled ? '虚拟地址 · CR3 ' + hex(data.cr3) : '虚拟地址 · 分页未开启'}` : '';
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
  function renderPaging(data) {
    const path = $('paging-path'); path.replaceChildren();
    const body = $('paging-body'); body.replaceChildren();
    $('paging-meta').textContent = data ? `CR0 ${hex(data.cr0)} · CR4 ${hex(data.cr4)} · WP=${Number(data.wp)} · PSE=${Number(data.pse)}` : '';
    $('paging-result').textContent = ''; $('paging-result').className = 'paging-result';
    $('paging-permissions').replaceChildren(); $('paging-explanation').textContent = data?.explanation ?? '';
    $('paging-warnings').textContent = data?.warnings.join('\n') ?? ''; $('paging-warnings').hidden = !data?.warnings.length;
    if (!data) return;
    const stage = (title, detail, className) => {
      if (path.childNodes.length) path.appendChild(element('span', '→', 'paging-arrow'));
      const node = element('div', undefined, `paging-stage${className ? ' ' + className : ''}`);
      node.appendChild(element('span', title, 'paging-stage-title')); node.appendChild(element('strong', detail)); path.appendChild(node);
    };
    stage('虚拟线性地址', hex(data.address));
    if (data.pagingEnabled) {
      stage('CR3 · 页目录物理基址', hex(data.directoryBase ?? data.cr3));
      stage(`PDE[${data.directoryIndex}]`, data.pde ? hex(data.pde.raw) : '未读取', data.faultLevel === 'directory' ? 'paging-fault' : '');
      if (data.pte || (data.pde?.present && !data.pde.pageSize && data.status !== 'unsupported')) stage(`PTE[${data.tableIndex}]`, data.pte ? hex(data.pte.raw) : '未读取', data.faultLevel === 'table' ? 'paging-fault' : '');
    }
    if (data.physicalAddress !== undefined) stage('物理地址', hex(data.physicalAddress), 'paging-resolved');
    else stage('转换未完成', ({ 'not-present': '页面不存在', invalid: '表项无效', unsupported: '当前模式不支持' }[data.status] ?? '不可用'), 'paging-fault');
    const status = ({ identity: '分页未开启 · 线性地址直接对应物理地址', mapped: `映射成功 · ${data.pageSize === 4194304 ? '4 MiB 大页' : '4 KiB 页'} · 页内偏移 ${hex(data.offset, data.pageSize === 4194304 ? 6 : 3)}`, 'not-present': `${data.faultLevel === 'directory' ? '页目录项' : '页表项'} P=0 · 无物理映射`, invalid: '表项含无效或保留位', unsupported: '当前分页模式不受支持' }[data.status] ?? '');
    $('paging-result').textContent = status;
    $('paging-result').classList.toggle('paging-fault', !['identity', 'mapped'].includes(data.status));
    for (const entry of [data.pde, data.pte].filter(Boolean)) {
      const row = element('tr'); row.dataset.level = entry.level;
      if (!entry.present || entry.reservedBits) row.className = 'row-warning';
      cell(row, `${entry.level === 'directory' ? 'PDE' : 'PTE'}[${entry.index}]`); cell(row, hex(entry.address)); cell(row, hex(entry.raw)); cell(row, hex(entry.base));
      cell(row, Number(entry.present)); cell(row, entry.writable ? '1 · 可写' : '0 · 只读'); cell(row, entry.user ? '1 · 用户' : '0 · 管理');
      const flags = [];
      if (entry.writeThrough) flags.push('PWT'); if (entry.cacheDisable) flags.push('PCD'); if (entry.accessed) flags.push('A');
      if (entry.dirty) flags.push('D'); if (entry.pageSize) flags.push(data.pse ? 'PS · 4 MiB' : 'PS · 已忽略'); if (entry.global) flags.push('G'); if (entry.pat) flags.push('PAT');
      if (entry.reservedBits) flags.push(`保留位 ${hex(entry.reservedBits)}`);
      cell(row, flags.join(' · ') || '—'); body.appendChild(row);
    }
    if (data.effective) {
      const p = data.effective;
      $('paging-permissions').appendChild(element('strong', '页级访问权限'));
      for (const [title, allowed] of [['管理态读取', p.supervisorRead], ['管理态写入', p.supervisorWrite], ['用户态读取', p.userRead], ['用户态写入', p.userWrite]]) {
        $('paging-permissions').appendChild(element('span', `${title} ${allowed ? '允许' : '禁止'}`, `permission ${allowed ? 'allowed' : 'denied'}`));
      }
    }
  }
  const accessName = access => ({ write: '写入', read: '读取', readWrite: '读取或写入' }[access] ?? access);
  const originName = origin => ({ native: 'VS Code', custom: '面板', both: 'VS Code + 面板' }[origin] ?? '—');
  function renderDisassembly(snapshot, canMutate) {
    const data = snapshot.disassembly; const body = $('disassembly-body'); body.replaceChildren();
    $('disassembly-meta').textContent = data ? `${data.bits} 位 · PC ${hex(data.pc)} · ${data.instructions.length} 条` : '';
    for (const instruction of data?.instructions ?? []) {
      const address = Number(instruction.address);
      const breakpoint = snapshot.instructionBreakpoints?.find(item => item.address === address);
      const row = element('tr'); row.dataset.address = String(address);
      if (address === data.pc) row.classList.add('current-pc');
      if (instruction.presentationHint === 'invalid') row.classList.add('invalid-instruction');
      const toggle = element('button', breakpoint ? '●' : '○', `breakpoint-toggle${breakpoint ? ' enabled' : ''}`);
      toggle.type = 'button'; toggle.dataset.address = String(address);
      toggle.setAttribute('aria-label', `${breakpoint ? '删除' : '添加'}地址 ${hex(address)} 的面板断点`);
      toggle.title = breakpoint?.origin === 'native' ? 'VS Code 原生断点，请在原生断点视图删除' : breakpoint?.origin === 'both' ? '删除面板断点；VS Code 原生断点仍保留' : breakpoint ? '删除面板地址断点' : '添加地址断点';
      toggle.disabled = !canMutate || breakpoint?.origin === 'native' || instruction.presentationHint === 'invalid';
      toggle.addEventListener('click', () => post('instructionBreakpoint', { address, enabled: !breakpoint }));
      cell(row, '').appendChild(toggle);
      const location = cell(row, `${address === data.pc ? '▶ ' : '  '}${hex(address)}`, 'instruction-address');
      if (breakpoint?.origin === 'native' || breakpoint?.origin === 'both') location.appendChild(element('span', 'VS Code', 'tag'));
      cell(row, instruction.instructionBytes.match(/.{1,2}/g)?.join(' ').toUpperCase() ?? '—', 'instruction-bytes');
      cell(row, instruction.instruction, 'instruction-text'); body.appendChild(row);
    }
  }
  function renderWatchpoints(snapshot, canMutate) {
    const data = snapshot.watchpoints; const body = $('watchpoint-body'); body.replaceChildren();
    const hit = data?.lastHit;
    $('watchpoint-hit').hidden = !hit;
    $('watchpoint-hit').textContent = hit ? `已命中：${accessName(hit.access)} ${hex(hit.address)} · 暂停 PC ${hex(hit.pc)}` : '';
    for (const breakpoint of data?.breakpoints ?? []) {
      const row = element('tr'); row.dataset.id = String(breakpoint.id); row.dataset.address = String(breakpoint.address);
      const matched = hit?.ids.includes(breakpoint.id);
      if (matched) row.classList.add('watchpoint-hit');
      cell(row, matched ? '● 已命中' : breakpoint.verified ? '● 已启用' : '未验证', 'breakpoint-status');
      cell(row, hex(breakpoint.address)); cell(row, `${breakpoint.size} 字节`); cell(row, accessName(breakpoint.access)); cell(row, originName(breakpoint.origin));
      const remove = element('button', '删除', 'secondary watchpoint-remove'); remove.type = 'button'; remove.dataset.id = String(breakpoint.id);
      remove.disabled = !canMutate || breakpoint.origin === 'native';
      remove.title = breakpoint.origin === 'native' ? 'VS Code 原生数据断点，请在原生断点视图删除' : breakpoint.origin === 'both' ? '删除面板断点；VS Code 原生数据断点仍保留' : '删除面板数据断点';
      remove.addEventListener('click', () => post('watchpoint', { action: 'remove', id: breakpoint.id })); cell(row, '').appendChild(remove);
      if (breakpoint.message) row.title = breakpoint.message;
      body.appendChild(row);
    }
    if (data && !data.breakpoints.length) { const row = element('tr'); const td = cell(row, '尚未设置数据断点。添加要监视的地址后继续运行。', 'table-empty'); td.colSpan = 6; body.appendChild(row); }
  }
  function render(snapshot) {
    const previousAddress = state?.form.address;
    const previousPagingAddress = state?.form.pagingAddress;
    state = snapshot;
    notify('');
    const { form } = snapshot; const memory = form.tab === 'memory'; const descriptor = form.tab === 'gdt' || form.tab === 'idt';
    for (const tab of tabs) {
      const selected = tab === form.tab;
      $(`tab-${tab}`).setAttribute('aria-selected', String(selected)); $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
    }
    $('memory-view').hidden = !memory; $('descriptor-view').hidden = !descriptor; $('disassembly-view').hidden = form.tab !== 'disassembly'; $('watchpoint-view').hidden = form.tab !== 'watchpoints'; $('paging-view').hidden = form.tab !== 'paging';
    if (document.activeElement !== $('address') || previousAddress !== form.address) $('address').value = hex(form.address);
    $('follow').value = form.follow; $('memory-space').value = form.memorySpace;
    $('memory-address-label').textContent = form.memorySpace === 'physical' ? '物理地址' : '虚拟线性地址';
    const canRead = snapshot.status === 'stopped'; const canMutate = canRead && !snapshot.busy && !snapshot.stale;
    $('status').textContent = snapshot.message; $('status-dot').className = `dot ${snapshot.status}`;
    document.body.classList.toggle('stale', snapshot.stale);
    const data = snapshot[form.tab];
    $('stale').hidden = !snapshot.stale || !data;
    $('refresh').disabled = !canRead || snapshot.busy;
    $('address').disabled = !canRead; $('go').disabled = !canRead || snapshot.busy; $('follow').disabled = !canRead || form.memorySpace === 'physical'; $('memory-space').disabled = !canRead;
    if (document.activeElement !== $('paging-address') || previousPagingAddress !== form.pagingAddress) $('paging-address').value = hex(form.pagingAddress);
    $('paging-address').disabled = !canRead; $('paging-go').disabled = !canRead || snapshot.busy;
    const memoryAddress = snapshot.memory?.address ?? form.address;
    $('memory-prev').disabled = !canRead || snapshot.busy || memoryAddress === 0;
    $('memory-next').disabled = !canRead || snapshot.busy || memoryAddress >= 0xffffff00;
    const table = descriptor ? snapshot[form.tab] : undefined;
    $('descriptor-prev').disabled = !canRead || snapshot.busy || (table?.start ?? 0) === 0;
    $('descriptor-next').disabled = !canRead || snapshot.busy || !table || table.start + table.count >= table.totalEntries;
    $('empty').hidden = Boolean(data);
    if (document.activeElement !== $('disassembly-address') || state.disassembly?.address !== snapshot.disassembly?.address) $('disassembly-address').value = hex(snapshot.disassembly?.address ?? form.disassemblyAddress);
    $('disassembly-address').disabled = !canRead; $('disassembly-go').disabled = !canRead || snapshot.busy;
    $('disassembly-follow').checked = form.disassemblyFollow; $('disassembly-follow').disabled = !canRead;
    $('disassembly-next').disabled = !canRead || snapshot.busy || !snapshot.disassembly || snapshot.disassembly.nextAddress > 0xffffffff;
    for (const id of ['watchpoint-address', 'watchpoint-size', 'watchpoint-access', 'watchpoint-add']) $(id).disabled = !canMutate;
    $('watchpoint-clear').disabled = !canMutate || !snapshot.watchpoints?.breakpoints.some(item => item.origin !== 'native');
    if (memory) renderMemory(snapshot.memory);
    else if (form.tab === 'paging') renderPaging(snapshot.paging);
    else if (descriptor) renderDescriptors(table, form.tab);
    else if (form.tab === 'disassembly') renderDisassembly(snapshot, canMutate);
    else renderWatchpoints(snapshot, canMutate);
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
  $('memory-space').addEventListener('change', () => configure({ memorySpace: $('memory-space').value }));
  $('paging-form').addEventListener('submit', event => { event.preventDefault(); post('pagingAddress', { address: $('paging-address').value }); });
  $('follow').addEventListener('change', () => configure({ follow: $('follow').value }));
  $('refresh').addEventListener('click', () => post('refresh'));
  $('disassembly-form').addEventListener('submit', event => { event.preventDefault(); post('disassemblyAddress', { address: $('disassembly-address').value }); });
  $('disassembly-follow').addEventListener('change', () => configure({ disassemblyFollow: $('disassembly-follow').checked }));
  $('disassembly-next').addEventListener('click', () => post('disassemblyNext'));
  $('watchpoint-form').addEventListener('submit', event => { event.preventDefault(); post('watchpoint', { action: 'add', address: $('watchpoint-address').value, size: Number($('watchpoint-size').value), access: $('watchpoint-access').value }); });
  $('watchpoint-clear').addEventListener('click', () => post('watchpoint', { action: 'clear' }));
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
