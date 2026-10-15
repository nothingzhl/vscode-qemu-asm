/* The webview only renders frames supplied by the extension. */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const screen = document.getElementById('screen');
  const frame = document.getElementById('frame');
  const placeholder = document.getElementById('placeholder');
  const status = document.getElementById('status');
  const statusDot = document.getElementById('status-dot');
  const dimensions = document.getElementById('dimensions');
  const keyboard = document.getElementById('keyboard');
  const keyboardHint = document.getElementById('keyboard-hint');
  const resetKeys = document.getElementById('reset-keys');
  const notice = document.getElementById('notice');
  const fit = document.getElementById('fit');
  const actual = document.getElementById('actual');
  let connected = false;
  let keyboardEnabled = false;
  let pendingFrame;
  let nextFrame;

  function updateKeyboard() {
    keyboard.disabled = !connected;
    keyboard.textContent = keyboardEnabled ? '关闭键盘输入' : '开启键盘输入';
    keyboard.setAttribute('aria-pressed', String(keyboardEnabled));
    resetKeys.disabled = !connected || !keyboardEnabled;
    screen.classList.toggle('keyboard-enabled', keyboardEnabled);
    keyboardHint.textContent = !keyboardEnabled ? '键盘输入已关闭'
      : document.activeElement === screen ? '按键将发送到模拟器 · 点击外部可释放'
        : '请点击屏幕，再输入按键';
  }

  function setScale(fitted) {
    screen.classList.toggle('fit', fitted);
    screen.classList.toggle('actual', !fitted);
    fit.classList.toggle('active', fitted);
    actual.classList.toggle('active', !fitted);
    fit.setAttribute('aria-pressed', String(fitted));
    actual.setAttribute('aria-pressed', String(!fitted));
  }

  function clearNotice() {
    notice.textContent = '';
    notice.hidden = true;
  }

  fit.addEventListener('click', () => setScale(true));
  actual.addEventListener('click', () => setScale(false));
  document.getElementById('refresh').addEventListener('click', () => {
    clearNotice();
    vscode.postMessage({ type: 'refresh' });
  });
  keyboard.addEventListener('click', () => {
    if (!connected) return;
    keyboardEnabled = !keyboardEnabled;
    updateKeyboard();
  });
  resetKeys.addEventListener('click', () => {
    if (connected && keyboardEnabled) vscode.postMessage({ type: 'key', key: 'ctrl-alt-delete' });
  });
  screen.addEventListener('focus', updateKeyboard);
  screen.addEventListener('blur', updateKeyboard);
  screen.addEventListener('click', () => screen.focus({ preventScroll: true }));

  const codeNames = {
    Enter: 'ret', NumpadEnter: 'ret', Escape: 'esc', Space: 'spc', Backspace: 'backspace',
    Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
    Minus: 'minus', Equal: 'equal', BracketLeft: 'bracket_left', BracketRight: 'bracket_right',
    Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Backquote: 'grave_accent',
    Comma: 'comma', Period: 'dot', Slash: 'slash', CapsLock: 'caps_lock',
  };
  screen.addEventListener('keydown', event => {
    if (!connected || !keyboardEnabled || document.activeElement !== screen || event.isComposing || event.metaKey) return;
    let key = codeNames[event.code];
    if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
    else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
    else if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) key = event.code.toLowerCase();
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('ctrl');
    if (event.altKey) modifiers.push('alt');
    if (event.shiftKey) modifiers.push('shift');
    vscode.postMessage({ type: 'key', key: [...modifiers, key].join('-') });
  });

  function loadFrame(message) {
    pendingFrame = message;
    const image = new Image();
    nextFrame = image;
    image.onload = () => {
      if (nextFrame !== image) return;
      frame.src = message.data;
      frame.hidden = false;
      placeholder.hidden = true;
      dimensions.textContent = `${message.width} × ${message.height}`;
      pendingFrame = undefined;
      nextFrame = undefined;
    };
    image.onerror = () => {
      if (nextFrame !== image) return;
      pendingFrame = undefined;
      nextFrame = undefined;
      notice.textContent = '无法解码模拟器画面，请刷新重试';
      notice.hidden = false;
    };
    image.src = message.data;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'frame' && typeof message.data === 'string'
      && message.data.startsWith('data:image/png;base64,') && message.data.length <= 45 * 1024 * 1024
      && Number.isInteger(message.width) && Number.isInteger(message.height)
      && message.width > 0 && message.width <= 8192 && message.height > 0 && message.height <= 8192) {
      if (pendingFrame && pendingFrame.data === message.data) return;
      loadFrame(message);
    } else if (message.type === 'status' && ['connecting', 'connected', 'error', 'stopped'].includes(message.state)) {
      status.textContent = typeof message.message === 'string' ? message.message : '';
      statusDot.className = `status-dot ${message.state}`;
      connected = message.state === 'connected';
      if (!connected) keyboardEnabled = false;
      updateKeyboard();
      if (connected) clearNotice();
    } else if (message.type === 'notice' && typeof message.message === 'string') {
      notice.textContent = message.message;
      notice.hidden = false;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
