// @ts-check
/* Runtime Lens explorer webview. No frameworks: the whole surface is a list,
   a detail pane and a filter bar, and hand-written DOM keeps the bundle at
   zero bytes of dependencies while staying instant on 400 rows. */
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  const statusEl = document.getElementById('status');
  const searchEl = document.getElementById('search');
  const levelsEl = document.getElementById('levels');
  const pauseEl = document.getElementById('pause');
  const followEl = document.getElementById('follow');
  const clearEl = document.getElementById('clear');

  let events = [];
  let selectedKey = null;
  let follow = true;
  let paused = false;

  const GLYPH = { log: '›', info: 'i', warn: '!', error: '✖', debug: '·', table: '▦' };

  function debounce(fn, ms) {
    let handle;
    return function () {
      const args = arguments;
      clearTimeout(handle);
      handle = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function activeLevels() {
    const boxes = levelsEl.querySelectorAll('input[type=checkbox]');
    const on = [];
    boxes.forEach(function (box) { if (box.checked) { on.push(box.value); } });
    return on.length === boxes.length ? [] : on;
  }

  const sendFilter = debounce(function () {
    vscode.postMessage({ type: 'filter', query: searchEl.value, levels: activeLevels() });
  }, 120);

  searchEl.addEventListener('input', sendFilter);
  levelsEl.addEventListener('change', sendFilter);

  clearEl.addEventListener('click', function () {
    vscode.postMessage({ type: 'clear' });
  });

  pauseEl.addEventListener('click', function () {
    paused = !paused;
    pauseEl.textContent = paused ? 'Resume' : 'Pause';
    pauseEl.classList.toggle('on', paused);
    vscode.postMessage({ type: 'pause', paused: paused });
  });

  followEl.addEventListener('click', function () {
    follow = !follow;
    followEl.classList.toggle('on', follow);
    vscode.postMessage({ type: 'follow', follow: follow });
  });

  function render() {
    listEl.textContent = '';
    events.forEach(function (event) {
      const li = document.createElement('li');
      li.className = 'kind-' + event.kind + (event.level ? ' level-' + event.level : '');
      if (event.key === selectedKey) { li.classList.add('selected'); }

      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = event.kind === 'expr' ? '?' : event.kind === 'error' ? '✖' : GLYPH[event.level] || '›';

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = event.text;

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = event.short + ':' + event.line + (event.count > 1 ? ' ×' + event.count : '') + (event.remapped ? ' ↺' : '');

      li.appendChild(glyph);
      li.appendChild(text);
      li.appendChild(meta);

      li.addEventListener('click', function () {
        selectedKey = event.key;
        renderDetail(event);
        render();
      });
      li.addEventListener('dblclick', function () {
        vscode.postMessage({ type: 'reveal', key: event.key });
      });
      listEl.appendChild(li);
    });
    if (follow && listEl.firstChild) {
      listEl.scrollTop = 0;
    }
  }

  function renderDetail(event) {
    detailEl.textContent = '';
    const row = document.createElement('div');
    row.className = 'row';

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Go to source';
    openBtn.addEventListener('click', function () { vscode.postMessage({ type: 'reveal', key: event.key }); });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy value';
    copyBtn.addEventListener('click', function () { vscode.postMessage({ type: 'copy', key: event.key }); });

    const where = document.createElement('span');
    where.className = 'meta';
    where.textContent = event.file + ':' + event.line + ' · ' + new Date(event.ts).toLocaleTimeString();

    row.appendChild(openBtn);
    row.appendChild(copyBtn);
    row.appendChild(where);

    const pre = document.createElement('pre');
    pre.textContent = event.detail;

    detailEl.appendChild(row);
    detailEl.appendChild(pre);
  }

  window.addEventListener('message', function (message) {
    const data = message.data;
    if (!data || data.type !== 'snapshot') { return; }
    events = data.events || [];
    if (typeof data.paused === 'boolean' && data.paused !== paused) {
      paused = data.paused;
      pauseEl.textContent = paused ? 'Resume' : 'Pause';
      pauseEl.classList.toggle('on', paused);
    }
    const stats = data.stats || {};
    statusEl.textContent =
      (events.length + ' shown · ' + (stats.size || 0) + '/' + (stats.capacity || 0) + ' buffered · ' +
        (stats.totalAdded || 0) + ' total' + (stats.dropped ? ' · ' + stats.dropped + ' dropped' : '')) +
      (paused ? ' · PAUSED' : '');
    render();
    const selected = events.filter(function (e) { return e.key === selectedKey; })[0];
    if (selected) { renderDetail(selected); }
  });

  vscode.postMessage({ type: 'ready' });
})();
