/**
 * main.js — точка входу: стан програми, форма ручного вводу з валідацією,
 * перемикачі наборів і режимів, таблиці результатів, зв'язок з графіками.
 */
(function (Approx) {
  'use strict';

  const DEGREE_MIN = 1;
  const DEGREE_MAX = 4;
  const SET_KEYS = Approx.SET_KEYS;

  /** Стан програми. */
  const state = {
    datasetKey: 'set5',   // активний набір (редагується у формі, показується в таблицях)
    data: {},             // поточні (можливо, змінені вручну) точки кожного набору
    mode: 'all',          // 'interp' | 'lsq' | 'all'
    degree: 3,            // степінь МНК
    results: {},          // результати розрахунків для кожного набору
    tableSpace: 'x',      // таблиця поділених різниць у змінній 'x' або нормалізованій 't'
    tab: 'focus',         // активна вкладка: 'focus' («Набір») або 'compare' («Порівняння»)
    dirty: false,         // у формі є незастосовані зміни
    drafts: {}            // незастосовані правки форми по наборах (не губляться при перемиканні)
  };

  const els = {};                       // посилання на DOM-елементи
  /**
   * Графіки двох вкладок:
   *  - plots.focus.{lagrange, lsq, resid} — вкладка «Набір» (активний набір);
   *  - plots.compare.{lagrange, lsq}[набір] — вкладка «Порівняння» (6 полотен).
   */
  const plots = { focus: {}, compare: { lagrange: {}, lsq: {} } };
  let chartEntries = [];  // [{fig, chart, view, kind, set}] — для обходу всіх графіків
  const TABS = ['focus', 'compare'];
  let demo = null;        // покрокова анімація на вкладці «Набір» (animation.js)

  // ---------- Форматування ----------

  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const toSub = (n) => String(n).split('').map((d) => SUB[+d]).join('');
  const toSup = (n) => String(n).split('').map((d) => SUP[+d]).join('');
  const fmt = (v, precision) => Approx.formatValue(v, precision);

  /** Коефіцієнт для формули: 6 значущих цифр (в експоненційному записі — теж 6). */
  function fmtCoef(v) {
    const a = Math.abs(v);
    const s = a === 0 ? '0' : (a >= 1e5 || a < 1e-4) ? v.toExponential(5) : String(Number(v.toPrecision(6)));
    return s.replace(/-/g, '−');
  }

  /** Формула полінома: «P₃(x) = 0.1 + 0.98x − 0.02x² + 1.001x³» (змінна v — 'x' або 't'). */
  function formatPolynomial(coeffs, name, v) {
    const variable = v || 'x';
    let s = '';
    coeffs.forEach((c, j) => {
      const mag = fmtCoef(Math.abs(c));
      const term = j === 0 ? mag : j === 1 ? mag + variable : mag + variable + toSup(j);
      if (j === 0) s += (c < 0 ? '−' : '') + term;
      else s += (c < 0 ? ' − ' : ' + ') + term;
    });
    return name + ' = ' + s;
  }

  /**
   * Формула МНК для показу. Звичайно — у змінній x. Але якщо x далеко від нуля
   * (напр. 1000…1003), розкриття (x − c)ʲ дає величезні коефіцієнти з взаємним
   * знищенням, і округлена до 6 цифр формула вже не відтворює ŷᵢ. Тоді показуємо
   * формулу в нормалізованій змінній t — вона точна.
   */
  function polynomialText(fit, xs, ys) {
    const name = 'P' + toSub(fit.degree);
    const printed = fit.coeffs.map((c) => Number(fmtCoef(c).replace(/−/g, '-')));
    let err = 0;
    xs.forEach((x, i) => { err = Math.max(err, Math.abs(Approx.horner(printed, x) - fit.fitted[i])); });
    const yRange = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    const yAbs = Math.max.apply(null, ys.map(Math.abs));
    if (err <= 1e-3 * Math.max(yRange, 1e-9 * yAbs, Number.MIN_VALUE)) {
      return formatPolynomial(fit.coeffs, name + '(x)', 'x');
    }
    const c = fit.normalizer;
    return formatPolynomial(fit.coeffsT, name, 't') + ',   t = (x − ' + fmt(c.center) + ') / ' + fmt(c.half);
  }

  /** Відмінювання: 1 точка, 2 точки, 5 точок, 11 точок, 21 точка. */
  function pointsWord(n) {
    const d = n % 10, dd = n % 100;
    if (d === 1 && dd !== 11) return 'точка';
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'точки';
    return 'точок';
  }

  /** Назва набору: як у варіанті, або «7 точок (змінено)», якщо точки редагували. */
  function datasetTitle(key) {
    const orig = Approx.DATASETS[key].points;
    const cur = state.data[key];
    const same = cur.length === orig.length && cur.every((p, i) => p.x === orig[i].x && p.y === orig[i].y);
    return same ? Approx.DATASETS[key].short : cur.length + ' ' + pointsWord(cur.length) + ' (змінено)';
  }

  const clonePoints = (points) => points.map((p) => ({ x: p.x, y: p.y }));

  // Розбір і валідація введення — у js/validation.js (їх перевіряє й tests.html)
  const parsePoints = Approx.parsePoints;
  const validatePoints = Approx.validatePoints;

  // ---------- Форма ----------

  function makeInput(className, value) {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.className = className;
    input.value = value;
    return input;
  }

  /** Додає рядок у таблицю точок. */
  function appendRow(xRaw, yRaw) {
    const tr = document.createElement('tr');
    const tdIdx = document.createElement('td');
    tdIdx.className = 'idx';
    const tdX = document.createElement('td');
    tdX.appendChild(makeInput('in-x', xRaw || ''));
    const tdY = document.createElement('td');
    tdY.appendChild(makeInput('in-y', yRaw || ''));
    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-icon del';
    del.textContent = '×';
    tdDel.appendChild(del);
    tr.append(tdIdx, tdX, tdY, tdDel);
    els.pointsBody.appendChild(tr);
    return tr;
  }

  /** Оновлює номери рядків і підписи для екранних читачів. */
  function renumberRows() {
    Array.from(els.pointsBody.rows).forEach((tr, i) => {
      tr.cells[0].textContent = i + 1;
      tr.querySelector('.in-x').setAttribute('aria-label', 'x точки ' + (i + 1));
      tr.querySelector('.in-y').setAttribute('aria-label', 'y точки ' + (i + 1));
      tr.querySelector('.del').setAttribute('aria-label', 'Видалити точку ' + (i + 1));
    });
  }

  /** Заповнює форму точками активного набору. */
  function renderForm() {
    els.pointsBody.textContent = '';
    state.data[state.datasetKey].forEach((p) => appendRow(String(p.x), String(p.y)));
    renumberRows();
    els.datasetName.textContent = datasetTitle(state.datasetKey);
    showErrors([]);
    setDirty(false);
  }

  function readFormRows() {
    return Array.from(els.pointsBody.rows).map((tr) => ({
      xRaw: tr.querySelector('.in-x').value,
      yRaw: tr.querySelector('.in-y').value
    }));
  }

  function setDirty(value) {
    state.dirty = value;
    els.dirtyNote.hidden = !value;
  }

  /** Підсвічує помилкові поля і виводить список повідомлень. */
  function showErrors(errors) {
    const rows = els.pointsBody.rows;
    els.pointsBody.querySelectorAll('input').forEach((input) => {
      input.classList.remove('invalid');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('title');
    });
    errors.forEach((err) => {
      if (err.row < 0 || !rows[err.row]) return;
      const input = rows[err.row].querySelector(err.field === 'y' ? '.in-y' : '.in-x');
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      if (err.message) input.title = err.message;
    });

    const messages = Array.from(new Set(errors.map((e) => e.message).filter(Boolean)));
    els.errors.textContent = '';
    messages.slice(0, 6).forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m;
      els.errors.appendChild(li);
    });
    if (messages.length > 6) {
      const li = document.createElement('li');
      li.textContent = '…і ще ' + (messages.length - 6);
      els.errors.appendChild(li);
    }
  }

  // ---------- Розрахунки ----------

  /**
   * Перераховує інтерполяцію та МНК (зі спільним степенем m) для всіх трьох наборів.
   * @param {{interp?: boolean}} [opts] — interp: false — лише МНК (зміна m:
   *   Лагранж від m не залежить, його не перераховуємо й не передискретизуємо)
   */
  function recompute(opts) {
    const withInterp = !opts || opts.interp !== false;
    SET_KEYS.forEach((key) => {
      const xs = state.data[key].map((p) => p.x);
      const ys = state.data[key].map((p) => p.y);
      const prev = state.results[key];

      // Інтерполяція в нормалізованій змінній t ∈ [−1, 1] і перевірка вузлів
      const interp = withInterp || !prev ? Approx.createInterpolant(xs, ys) : prev.interp;
      const check = withInterp || !prev ? Approx.verifyNodes(interp) : prev.check;

      let fit = null;
      let fitError = '';
      try {
        fit = Approx.lsqFit(xs, ys, state.degree);
      } catch (e) {
        fitError = e.message;
      }
      state.results[key] = { xs: xs, ys: ys, interp: interp, check: check, fit: fit, fitError: fitError };
    });
    feedCharts({ lagrange: withInterp });
  }

  // Дані для графіків одного набору (однакові для обох вкладок)

  function lagrangeData(key) {
    const r = state.results[key];
    return {
      points: state.data[key],
      curves: [{ key: 'model', label: 'L' + toSub(r.xs.length - 1) + '(x)', fnName: 'L(x)', fn: r.interp.lagrange, color: 'curve' }]
    };
  }

  function lsqData(key) {
    const r = state.results[key];
    return {
      points: state.data[key],
      // fit.evaluate рахує в нормалізованій змінній t
      curves: r.fit ? [{ key: 'model', label: 'P' + toSub(r.fit.degree) + '(x), МНК', fnName: 'P(x)', fn: r.fit.evaluate, color: 'lsq' }] : [],
      residuals: r.fit ? { curveKey: 'model', values: r.fit.residuals } : null,
      message: r.fitError
    };
  }

  function residData(key) {
    const r = state.results[key];
    return {
      points: state.data[key],
      residuals: r.fit ? r.fit.residuals : [],
      fitted: r.fit ? r.fit.fitted : [],
      rmse: r.fit ? r.fit.RMSE : 0,
      degree: r.fit ? r.fit.degree : state.degree,
      message: r.fitError
    };
  }

  /**
   * Передає результати всім графікам: шести у «Порівнянні» і трьом у «Наборі».
   * Межі осей кожне полотно рахує само (автомасштаб у plot.js).
   */
  function feedCharts(opts) {
    const withLagrange = !opts || opts.lagrange !== false;
    SET_KEYS.forEach((key) => {
      if (withLagrange) plots.compare.lagrange[key].setData(lagrangeData(key));
      plots.compare.lsq[key].setData(lsqData(key));
    });
    if (withLagrange) plots.focus.lagrange.setData(lagrangeData(state.datasetKey));
    plots.focus.lsq.setData(lsqData(state.datasetKey));
    plots.focus.resid.setData(residData(state.datasetKey));
    updateCaptions();
    els.compareDegree.textContent = 'm = ' + state.degree;
  }

  const KIND_TITLES = { lagrange: 'Інтерполяція Лагранжа', lsq: 'Метод найменших квадратів', resid: 'Залишки МНК, r = y − ŷ' };

  /** Підписи над графіками: назва набору (і методу — у вкладці «Набір») та короткий підсумок. */
  function updateCaptions() {
    chartEntries.forEach((e) => {
      const key = e.set || state.datasetKey;
      const r = state.results[key];
      const short = datasetTitle(key);
      e.fig.querySelector('.chart-title').textContent =
        e.view === 'focus' ? KIND_TITLES[e.kind] + ' · ' + short : short;
      e.chart.canvas.setAttribute('aria-label', KIND_TITLES[e.kind] + ', ' + short);
      const sub = e.fig.querySelector('.chart-sub');
      if (e.kind === 'lagrange') {
        sub.textContent = 'степінь ' + (r.xs.length - 1) +
          (r.check.ok ? ' · ✓ через усі вузли' : ' · ✗ вузли не збігаються') +
          (e.chart.tailsClipped ? ' · ↕ екстраполяцію обрізано' : '');
      } else if (!r.fit) {
        sub.textContent = r.fitError;
      } else if (e.kind === 'resid') {
        sub.textContent = 'm = ' + r.fit.degree + ' · RMSE = ' + fmt(r.fit.RMSE, 4) + ' · max|r| = ' + fmt(r.fit.maxAbs, 4);
      } else {
        sub.textContent = 'm = ' + r.fit.degree + ' · SSE = ' + fmt(r.fit.SSE, 4) + ' · R² = ' + fmt(r.fit.R2, 5);
      }
    });
  }

  // ---------- Таблиці ----------

  function cell(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  /** Таблиця залишків МНК і підсумкові метрики. */
  function renderResidualTable(result) {
    const t = els.residualTable;
    t.textContent = '';
    els.lsqSummary.textContent = '';

    if (!result.fit) {
      els.lsqFormula.textContent = result.fitError;
      return;
    }
    const fit = result.fit;
    els.lsqFormula.textContent = polynomialText(fit, result.xs, result.ys);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['i', 'xᵢ', 'yᵢ', 'ŷᵢ = P(xᵢ)', 'rᵢ = yᵢ − ŷᵢ'].forEach((h) => hr.appendChild(cell('th', h)));
    thead.appendChild(hr);

    const tbody = document.createElement('tbody');
    result.xs.forEach((x, i) => {
      const tr = document.createElement('tr');
      tr.append(
        cell('td', String(i)),
        cell('td', fmt(x)),
        cell('td', fmt(result.ys[i])),
        cell('td', fmt(fit.fitted[i])),
        cell('td', fmt(fit.residuals[i]))
      );
      tbody.appendChild(tr);
    });
    t.append(thead, tbody);

    [
      ['SSE = Σrᵢ²', fmt(fit.SSE)],
      ['RMSE = √(SSE/n)', fmt(fit.RMSE)],
      ['max |rᵢ|', fmt(fit.maxAbs)],
      ['R²', fmt(fit.R2, 6)]
    ].forEach((pair) => {
      const wrap = document.createElement('div');
      wrap.append(cell('dt', pair[0]), cell('dd', pair[1]));
      els.lsqSummary.appendChild(wrap);
    });
  }

  /** Таблиці для активного набору. */
  function renderTables() {
    const r = state.results[state.datasetKey];
    const name = datasetTitle(state.datasetKey);
    els.dividedTitle.textContent = 'Таблиця поділених різниць · ' + name;
    Approx.renderNodeCheck(els.newtonInfo, r.check, r.interp);
    Approx.renderDividedTable(els.dividedTable, r.interp, { space: state.tableSpace });
    els.residualTitle.textContent = 'Залишки МНК · ' + name;
    renderResidualTable(r);
  }

  // ---------- Відображення ----------

  /** Показує лише блоки, що відповідають режиму «Інтерполяція / МНК / Усі» (в обох вкладках). */
  function applyModeVisibility() {
    state.mode = Approx.ChartMode.apply(state.mode);
  }

  /** У «Порівнянні» виділяє рамкою графіки активного набору. */
  function updateActiveHighlight() {
    chartEntries.forEach((e) => {
      e.fig.classList.toggle('is-active', e.view === 'compare' && e.set === state.datasetKey);
    });
  }

  /** Чи видно графік зараз (не в прихованій вкладці і не прихований режимом). */
  function isShown(e) {
    return e.fig.getClientRects().length > 0;
  }

  /**
   * Перемальовує графіки: видимі, що задовольняють умову, — з анімацією, решту — без.
   * Приховані полотна не малюються; коли стануть видимими, plot.js перемалює їх сам.
   * @param {function(Object): boolean} shouldAnimate — умова для запису з chartEntries
   */
  function renderCharts(shouldAnimate) {
    chartEntries.forEach((e) => {
      if (isShown(e) && shouldAnimate(e)) e.chart.animate();
      else e.chart.redraw();
    });
  }

  /** Перемикає вкладку «Набір» / «Порівняння». */
  function selectTab(tab, moveFocus) {
    state.tab = TABS.indexOf(tab) >= 0 ? tab : 'focus';
    els.tabs.forEach((btn) => {
      const on = btn.dataset.tab === state.tab;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && moveFocus) btn.focus();
    });
    els.panels.forEach((panel) => {
      panel.hidden = panel.id !== 'panel-' + state.tab;
    });
    // Вкладка в адресі: сторінку з #compare одразу відкрито на порівнянні
    try {
      history.replaceState(null, '', state.tab === 'compare' ? '#compare' : location.pathname + location.search);
    } catch (err) { /* file:// у деяких браузерах не дозволяє — не критично */ }
    if (state.tab !== 'focus' && demo.state === 'playing') demo.pause(); // анімація чекає, поки вкладку не відкриють знову
    // Графіки «Набору», на яких стоїть кадр анімації, не перезапускаємо
    const demoActive = demo.state === 'playing' || demo.state === 'paused';
    renderCharts((e) => e.view === state.tab && !(demoActive && e.view === 'focus'));
  }

  // ---------- Обробники подій ----------

  function onTabClick(e) {
    const btn = e.target.closest('.tab');
    if (btn && btn.dataset.tab !== state.tab) selectTab(btn.dataset.tab, false);
  }

  /** Клавіатура у вкладках: ←/→, Home/End (шаблон WAI-ARIA Tabs). */
  function onTabKeydown(e) {
    const i = TABS.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next, true);
    }
  }

  /** Повертає у форму збережену чернетку активного набору (з підсвіченими помилками). */
  function restoreDraft() {
    const draft = state.drafts[state.datasetKey];
    if (!draft) return;
    els.pointsBody.textContent = '';
    draft.forEach((r) => appendRow(r.xRaw, r.yRaw));
    renumberRows();
    setDirty(true);
    showErrors(validatePoints(draft).errors);
  }

  function onDatasetChange(e) {
    demo.reset();
    // Незастосовані правки не губимо: зберігаємо чернетку й повертаємо її, коли набір знову обрано
    if (state.dirty) state.drafts[state.datasetKey] = readFormRows();
    state.datasetKey = e.target.value;
    renderForm();
    restoreDraft();
    feedCharts();
    renderTables();
    updateActiveHighlight();
    // У «Наборі» — нові дані з анімацією; у «Порівнянні» лише переїжджає рамка
    renderCharts((c) => c.view === 'focus');
  }

  function onTableSpaceChange(e) {
    state.tableSpace = e.target.value;
    renderTables();
  }

  function onModeChange(e) {
    demo.reset(); // набір видимих графіків змінився — план анімації застарів
    state.mode = e.target.value;
    applyModeVisibility();
    renderCharts(() => true);
  }

  function onDegreeChange() {
    demo.reset();
    const m = parseInt(els.degree.value, 10);
    state.degree = Math.min(DEGREE_MAX, Math.max(DEGREE_MIN, Number.isFinite(m) ? m : 3));
    recompute({ interp: false });
    renderTables();
    renderCharts((c) => c.kind !== 'lagrange'); // Лагранж від m не залежить
  }

  /** Жива валідація під час набору — лише підсвічування, без перерахунку. */
  function onPointsInput(e) {
    if (e.target === els.bulkInput) return;
    setDirty(true);
    showErrors(validatePoints(readFormRows()).errors);
  }

  function onFormSubmit(e) {
    e.preventDefault();
    const result = validatePoints(readFormRows());
    showErrors(result.errors);
    if (!result.ok) {
      const firstInvalid = els.pointsBody.querySelector('.invalid');
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    demo.reset();
    delete state.drafts[state.datasetKey];
    state.data[state.datasetKey] = result.points;
    renderForm(); // точки повертаються у форму відсортованими за x
    recompute();
    renderTables();
    renderCharts((c) => c.view === 'focus' || c.set === state.datasetKey);
  }

  function onRowClick(e) {
    const btn = e.target.closest('.del');
    if (!btn) return;
    btn.closest('tr').remove();
    renumberRows();
    setDirty(true);
    showErrors(validatePoints(readFormRows()).errors);
  }

  function onAddPoint() {
    const tr = appendRow('', '');
    renumberRows();
    setDirty(true);
    tr.querySelector('.in-x').focus();
  }

  function onResetPoints() {
    demo.reset();
    delete state.drafts[state.datasetKey];
    state.data[state.datasetKey] = clonePoints(Approx.DATASETS[state.datasetKey].points);
    renderForm();
    recompute();
    renderTables();
    renderCharts((c) => c.view === 'focus' || c.set === state.datasetKey);
  }

  /** Переносить точки зі списку в таблицю форми (застосування — кнопкою «Застосувати»). */
  function onBulkApply() {
    const parsed = parsePoints(els.bulkInput.value);
    if (parsed.errors.length) {
      showErrors(parsed.errors);
      return;
    }
    els.pointsBody.textContent = '';
    parsed.rows.forEach((r) => appendRow(r.xRaw, r.yRaw));
    renumberRows();
    setDirty(true);
    showErrors(validatePoints(readFormRows()).errors);
  }

  // ---------- Ініціалізація ----------

  function init() {
    els.form = document.getElementById('points-form');
    els.pointsBody = document.getElementById('points-body');
    els.addPoint = document.getElementById('add-point');
    els.resetPoints = document.getElementById('reset-points');
    els.bulkInput = document.getElementById('bulk-input');
    els.bulkApply = document.getElementById('bulk-apply');
    els.errors = document.getElementById('errors');
    els.dirtyNote = document.getElementById('dirty-note');
    els.datasetName = document.getElementById('dataset-name');
    els.degree = document.getElementById('degree');
    els.dividedTable = document.getElementById('divided-table');
    els.newtonInfo = document.getElementById('newton-info');
    els.dividedTitle = document.getElementById('divided-title');
    els.residualTable = document.getElementById('residual-table');
    els.residualTitle = document.getElementById('residual-title');
    els.lsqFormula = document.getElementById('lsq-formula');
    els.lsqSummary = document.getElementById('lsq-summary');
    els.tooltip = document.getElementById('tooltip');
    els.compareDegree = document.getElementById('compare-degree');
    els.tabs = Array.from(document.querySelectorAll('.tab'));
    els.panels = Array.from(document.querySelectorAll('.tab-panel'));

    SET_KEYS.forEach((key) => {
      state.data[key] = clonePoints(Approx.DATASETS[key].points);
    });

    // Створюємо графіки за розміткою: data-view (вкладка), data-kind (метод), data-set (набір)
    chartEntries = Array.from(document.querySelectorAll('.chart')).map((fig) => {
      const view = fig.dataset.view;
      const kind = fig.dataset.kind;
      const set = fig.dataset.set || null;
      const Chart = kind === 'resid' ? Approx.ResidualPlot : Approx.Plot;
      const chart = new Chart(fig.querySelector('canvas'), { tooltip: els.tooltip });
      if (view === 'focus') plots.focus[kind] = chart;
      else plots.compare[kind][set] = chart;
      // Клік по легенді змінює видимі серії — оновлюємо підпис («екстраполяцію обрізано»)
      chart.canvas.addEventListener('chart:series', () => updateCaptions());
      return { fig: fig, chart: chart, view: view, kind: kind, set: set };
    });

    // Синхронізуємо стан з початковими значеннями елементів керування
    state.datasetKey = document.querySelector('input[name="dataset"]:checked').value;
    state.mode = document.querySelector('input[name="mode"]:checked').value;
    state.degree = parseInt(els.degree.value, 10);

    document.querySelectorAll('input[name="dataset"]').forEach((r) => r.addEventListener('change', onDatasetChange));
    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', onModeChange));
    document.querySelectorAll('input[name="table-space"]').forEach((r) => r.addEventListener('change', onTableSpaceChange));
    els.degree.addEventListener('change', onDegreeChange);
    els.form.addEventListener('submit', onFormSubmit);
    els.form.addEventListener('input', onPointsInput);
    els.pointsBody.addEventListener('click', onRowClick);
    els.addPoint.addEventListener('click', onAddPoint);
    els.resetPoints.addEventListener('click', onResetPoints);
    els.bulkApply.addEventListener('click', onBulkApply);
    demo = Approx.Animation.createDemo({
      charts: plots.focus,
      getData: () => {
        const r = state.results[state.datasetKey];
        return { xs: r.xs, ys: r.ys, fit: r.fit };
      },
      ui: {
        start: document.getElementById('demo-start'),
        pause: document.getElementById('demo-pause'),
        reset: document.getElementById('demo-reset'),
        status: document.getElementById('demo-status'),
        progress: document.getElementById('demo-progress')
      }
    });
    const tablist = document.querySelector('.tabs');
    tablist.addEventListener('click', onTabClick);
    tablist.addEventListener('keydown', onTabKeydown);
    // Зміну розміру і devicePixelRatio графіки відстежують самі (plot.js)
    if (window.matchMedia) {
      // Перемальовуємо графіки при зміні світлої/темної теми системи
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', () => renderCharts(() => false));
    }

    renderForm();
    recompute();
    renderTables();
    applyModeVisibility();
    updateActiveHighlight();
    selectTab(location.hash === '#compare' ? 'compare' : 'focus', false); // малює й анімує видиму вкладку
  }

  Approx.charts = plots; // екземпляри графіків — для перевірок у консолі
  Object.defineProperty(Approx, 'demo', { get: () => demo }); // керування анімацією з консолі
  Approx.formatPolynomial = formatPolynomial;

  document.addEventListener('DOMContentLoaded', init);
})(window.Approx = window.Approx || {});
