/**
 * plot.js — графіки на HTML5 Canvas без сторонніх бібліотек.
 *
 *  - Plot          — точки даних і криві моделей: осі, сітка, легенда (клік
 *                    вмикає/вимикає серію), підказка з похибкою в точці,
 *                    затінена зона екстраполяції, анімація промальовування;
 *  - ResidualPlot  — діаграма залишків МНК: штрихи від r = 0, маркери,
 *                    підписані лінії r = 0 і ±RMSE;
 *  - ChartMode     — перемикач «Інтерполяція / МНК / Усі».
 *
 * Режим кадру (setFrame / clearFrame): покрокову анімацію з animation.js
 * графік не рахує сам — він отримує готовий вміст кадру і межі осей
 * і лише малює їх. Підказки й клік по легенді в цьому режимі вимкнено.
 *
 * Автомасштаб: межі рахуються з точок і ВСІХ ВИДИМИХ кривих (за повними даними),
 * потім додається відступ 10 % з кожного боку. Під час анімації появи (animate)
 * межі не змінюються; у покроковій анімації (animation.js) їх плавно веде
 * BoundsFollower. Майже сталі дані (розкид на рівні округлень) розширюються
 * до ±10 % від значення — інакше масштаб «провалився» б у шум округлення.
 * Хвости кривих у зоні екстраполяції можуть розширити вісь y не більше ніж на
 * половину розмаху даних з кожного боку — інакше поліном високого степеня (Рунге)
 * стиснув би всі точки в лінію; обрізання позначається стрілкою.
 */
(function (Approx) {
  'use strict';

  const PAD_FRACTION = 0.10;   // відступ автомасштабу: 10 % розмаху з кожного боку
  const EXTRAP_CAP = 0.5;      // екстраполяція розширює y не більше ніж на 0.5 розмаху даних
  const CURVE_SAMPLES = 600;   // кількість точок дискретизації кривої
  const ANIM_DURATION = 700;   // тривалість анімації, мс
  const SNAP_RADIUS = 10;      // радіус «прилипання» курсора до точки, px
  const PY_LIMIT = 1e4;        // обмеження піксельних координат для Canvas
  const LEGEND_ROW = 18;       // висота рядка легенди, px
  const MAX_TICKS = 200;       // запобіжник: більше поділок на осі не буває
  const FLAT_RTOL = 1e-9;      // розкид, менший за 1e-9 від |y|, вважаємо нулем (шум округлення)

  // ---------- Допоміжні функції ----------

  /**
   * «Гарний» крок сітки: 1, 2 або 5 × 10^k.
   * @param {number} range — довжина діапазону
   * @param {number} maxTicks — бажана кількість поділок
   * @returns {number}
   */
  function niceStep(range, maxTicks) {
    if (!(range > 0) || !Number.isFinite(range)) return 1;
    const rough = range / Math.max(1, maxTicks);
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const f = rough / pow;
    const nice = f <= 1.5 ? 1 : f <= 3 ? 2 : f <= 7 ? 5 : 10;
    return nice * pow;
  }

  /**
   * Поділки осі на [min, max]: значення k·step для цілих k.
   * Цикл іде по цілих k від k0 до k1 і обмежений MAX_TICKS — навіть якщо step
   * виявиться мізерним відносно |min| (k ~ 1e16, де k++ уже не змінює k),
   * він не зациклиться.
   * @returns {{step:number, values:number[]}}
   */
  function niceTicks(min, max, maxTicks) {
    const step = niceStep(max - min, maxTicks);
    const k0 = Math.ceil(min / step);
    const k1 = Math.floor(max / step);
    const values = [];
    if (Number.isFinite(k0) && Number.isFinite(k1) && k1 - k0 <= MAX_TICKS) {
      for (let i = 0; i <= k1 - k0; i++) values.push((k0 + i) * step);
    }
    return { step: step, values: values };
  }

  /**
   * Підпис поділки: стільки знаків після коми, скільки потребує крок;
   * для дуже малих кроків або великих значень — експоненційний запис.
   */
  function formatTick(value, step) {
    const clean = Math.abs(value) < step * 1e-6 ? 0 : value;
    if (step >= 1e-4 && Math.abs(clean) < 1e6) {
      const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
      return clean.toFixed(decimals).replace('-', '−');
    }
    if (clean === 0) return '0';
    // Значущих цифр стільки, щоб сусідні поділки відрізнялися
    const digits = Math.min(6, Math.max(1, Math.ceil(Math.log10(Math.abs(clean) / step)) + 1));
    return clean.toExponential(digits - 1).replace(/-/g, '−');
  }

  /** Число для підказок і таблиць: до 6 значущих цифр або експоненційний запис. */
  function formatValue(v, precision) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    const s = (a >= 1e5 || a < 1e-4)
      ? v.toExponential(3)
      : String(Number(v.toPrecision(precision || 6)));
    return s.replace(/-/g, '−');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Кольори з CSS-змінних (світла/темна тема задається в style.css).
   * Запасні значення мають контраст ≥ 4.5:1 з білим тлом.
   */
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = function (name, fallback) { return cs.getPropertyValue(name).trim() || fallback; };
    const fontFamily = v('--font-ui', 'sans-serif');
    return {
      bg: v('--chart-bg', '#ffffff'),
      grid: v('--chart-grid', '#e6e3da'),
      axis: v('--chart-axis', '#6b7179'),
      text: v('--chart-text', '#4a525c'),
      point: v('--c-point', '#1c2229'),
      curve: v('--c-curve', '#1f4fa3'),
      lsq: v('--c-lsq', '#b8461b'),
      residual: v('--c-residual', '#b8461b'),
      highlight: v('--c-highlight', '#c2185b'),
      extrapBg: v('--c-extrap-bg', 'rgba(110, 100, 80, 0.07)'),
      extrapLine: v('--c-extrap-line', 'rgba(110, 100, 80, 0.22)'),
      guide: v('--c-guide', '#8a8f96'),
      zero: v('--c-zero', '#1c2229'),
      font: '12px ' + fontFamily,
      fontBold: '600 12px ' + fontFamily
    };
  }

  /** Рівномірна сітка на [a, b] плюс обов'язкові точки (межі даних). */
  function sampleGrid(a, b, count, extra) {
    const xs = [];
    for (let i = 0; i <= count; i++) xs.push(a + (b - a) * i / count);
    (extra || []).forEach(function (x) { xs.push(x); });
    xs.sort(function (p, q) { return p - q; });
    return xs.filter(function (x, i) { return i === 0 || x !== xs[i - 1]; });
  }

  // ---------- Спостереження за devicePixelRatio ----------

  const liveCharts = new Set();
  let dprQuery = null;

  /** Перемальовує всі графіки, коли змінюється щільність пікселів (інший монітор, масштаб). */
  function watchDevicePixelRatio() {
    if (!window.matchMedia) return;
    const onChange = function () {
      if (dprQuery) {
        if (dprQuery.removeEventListener) dprQuery.removeEventListener('change', onChange);
        else if (dprQuery.removeListener) dprQuery.removeListener(onChange);
      }
      dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      if (dprQuery.addEventListener) dprQuery.addEventListener('change', onChange);
      else if (dprQuery.addListener) dprQuery.addListener(onChange);
      liveCharts.forEach(function (chart) { chart.requestRedraw(); });
    };
    onChange();
  }

  // ======================================================================
  // BaseChart — спільна основа: полотно, масштаб, сітка, осі, підказка, анімація
  // ======================================================================

  class BaseChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{tooltip?: HTMLElement, xLabel?: string, yLabel?: string}} [options]
     */
    constructor(canvas, options) {
      const opts = options || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = opts.tooltip || null;
      this.xLabel = opts.xLabel || 'x';
      this.yLabel = opts.yLabel || 'y';

      this.dpr = 0;          // devicePixelRatio, з яким створено буфер
      this.width = 0;        // розмір у CSS-пікселях
      this.height = 0;
      this.padding = { top: 30, right: 14, bottom: 40, left: 56 };
      this.bounds = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
      this.theme = null;

      this.progress = 1;     // прогрес анімації 0…1
      this.cancelAnim = null;
      this.hover = null;     // що під курсором
      this.redrawQueued = false;
      this.message = '';
      this.frame = null;     // кадр покрокової анімації (див. setFrame)

      // Адаптивність: перемальовуємо при зміні розміру полотна (у т.ч. коли
      // прихований графік знову стає видимим після перемикання режиму)
      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.requestRedraw());
        this.resizeObserver.observe(canvas);
      } else {
        window.addEventListener('resize', () => this.requestRedraw());
      }
      if (!liveCharts.size) watchDevicePixelRatio();
      liveCharts.add(this);

      canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      canvas.addEventListener('pointerdown', (e) => this.onPointerMove(e)); // дотик теж показує підказку
      canvas.addEventListener('pointerleave', () => this.onPointerLeave());
      canvas.addEventListener('click', (e) => this.onClick(e));
    }

    get plotW() { return Math.max(1, this.width - this.padding.left - this.padding.right); }
    get plotH() { return Math.max(1, this.height - this.padding.top - this.padding.bottom); }

    /**
     * Підганяє буфер полотна під його CSS-розмір і devicePixelRatio.
     * @returns {boolean} false, якщо полотно приховане (нульовий розмір)
     */
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w !== this.width || h !== this.height || dpr !== this.dpr) {
        this.width = w;
        this.height = h;
        this.dpr = dpr;
        this.canvas.width = Math.max(1, Math.round(w * dpr));
        this.canvas.height = Math.max(1, Math.round(h * dpr));
      }
      return w > 0 && h > 0;
    }

    /** Координати даних → пікселі. */
    toPx(x, y) {
      const b = this.bounds, p = this.padding;
      return {
        px: p.left + (x - b.xMin) / (b.xMax - b.xMin) * this.plotW,
        py: p.top + (b.yMax - y) / (b.yMax - b.yMin) * this.plotH
      };
    }

    /** Пікселі → координати даних. */
    fromPx(px, py) {
      const b = this.bounds, p = this.padding;
      return {
        x: b.xMin + (px - p.left) / this.plotW * (b.xMax - b.xMin),
        y: b.yMax - (py - p.top) / this.plotH * (b.yMax - b.yMin)
      };
    }

    insidePlot(px, py) {
      const p = this.padding;
      return px >= p.left && px <= p.left + this.plotW && py >= p.top && py <= p.top + this.plotH;
    }

    /** Обмежує малювання прямокутником області графіка (потрібен ctx.restore()). */
    clipToPlot() {
      const ctx = this.ctx, p = this.padding;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.left, p.top, this.plotW, this.plotH);
      ctx.clip();
    }

    /** Поділки осі y (залежать лише від висоти області, тож їх можна знати до малювання). */
    yTicks() {
      return niceTicks(this.bounds.yMin, this.bounds.yMax, Math.max(3, Math.floor(this.plotH / 34)));
    }

    /** Лівий відступ за шириною найдовшого підпису осі y (довгі підписи не обрізаються). */
    fitLeftPadding() {
      const ctx = this.ctx;
      ctx.font = this.theme.font;
      const yt = this.yTicks();
      let w = 0;
      yt.values.forEach((y) => { w = Math.max(w, ctx.measureText(formatTick(y, yt.step)).width); });
      this.padding.left = Math.max(48, Math.ceil(w) + 30); // 30 = назва осі (обернута) + проміжок
    }

    /** Сітка, підписи поділок і назви осей. */
    drawGrid() {
      const ctx = this.ctx, b = this.bounds, p = this.padding, th = this.theme;
      const xt = niceTicks(b.xMin, b.xMax, Math.max(3, Math.floor(this.plotW / 60)));
      const yt = this.yTicks();

      ctx.lineWidth = 1;
      ctx.strokeStyle = th.grid;
      ctx.fillStyle = th.text;
      ctx.font = th.font;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      xt.values.forEach((x) => {
        const px = Math.round(this.toPx(x, 0).px) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, p.top);
        ctx.lineTo(px, p.top + this.plotH);
        ctx.stroke();
        ctx.fillText(formatTick(x, xt.step), px, p.top + this.plotH + 5);
      });

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      yt.values.forEach((y) => {
        const py = Math.round(this.toPx(0, y).py) + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.left, py);
        ctx.lineTo(p.left + this.plotW, py);
        ctx.stroke();
        ctx.fillText(formatTick(y, yt.step), p.left - 6, py);
      });

      // Назви осей
      ctx.font = th.fontBold;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(this.xLabel, p.left + this.plotW / 2, this.height - 2);
      ctx.save();
      ctx.translate(12, p.top + this.plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle';
      ctx.fillText(this.yLabel, 0, 0);
      ctx.restore();
    }

    /** Рамка області графіка й осі координат (якщо нуль у межах). */
    drawAxes() {
      const ctx = this.ctx, b = this.bounds, p = this.padding;
      ctx.strokeStyle = this.theme.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(p.left + 0.5, p.top + 0.5, this.plotW - 1, this.plotH - 1);
      ctx.lineWidth = 1.3;
      if (b.xMin < 0 && b.xMax > 0) {
        const px = Math.round(this.toPx(0, 0).px) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, p.top);
        ctx.lineTo(px, p.top + this.plotH);
        ctx.stroke();
      }
      if (b.yMin < 0 && b.yMax > 0) {
        const py = Math.round(this.toPx(0, 0).py) + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.left, py);
        ctx.lineTo(p.left + this.plotW, py);
        ctx.stroke();
      }
    }

    /** Повідомлення по центру (наприклад, замало точок для степеня m). */
    drawMessage() {
      if (!this.message) return;
      const ctx = this.ctx, th = this.theme, p = this.padding;
      ctx.font = th.font;
      const w = Math.min(this.plotW - 16, ctx.measureText(this.message).width + 20);
      const cx = p.left + this.plotW / 2;
      const cy = p.top + this.plotH / 2;
      ctx.fillStyle = th.bg;
      ctx.globalAlpha = 0.94;
      ctx.fillRect(cx - w / 2, cy - 14, w, 28);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = th.axis;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - w / 2 + 0.5, cy - 13.5, w - 1, 27);
      ctx.fillStyle = th.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, cx, cy, w - 12);
    }

    // ----- Режим кадру (керує animation.js) -----

    /**
     * Показує кадр анімації: вміст і межі осей задає контролер анімації.
     * @param {Object} frame — {bounds, ...вміст, специфічний для типу графіка}
     */
    setFrame(frame) {
      this.frame = frame;
      this.bounds = frame.bounds;
      if (this.hover) { this.hover = null; this.hideTooltip(); }
      this.render(1);
    }

    /** Повертає звичайне малювання за даними (межі — знову автомасштаб). */
    clearFrame() {
      if (!this.frame) return;
      this.frame = null;
      this.autoscale();
      this.redraw();
    }

    /** Зупиняє вбудовану анімацію появи (animate), якщо вона йде. */
    stopAnimation() {
      if (this.cancelAnim) { this.cancelAnim(); this.cancelAnim = null; }
      this.progress = 1;
    }

    autoscale() {}

    /** Розміщення елементів перед малюванням (легенда змінює верхній відступ). */
    layout() {}

    /** Вміст графіка — перевизначається в нащадках. */
    drawContent() {}

    /**
     * Повне перемальовування кадру.
     * @param {number} [progress] — прогрес анімації 0…1
     */
    render(progress) {
      const pr = progress === undefined ? this.progress : progress;
      if (!this.resize()) return;
      this.theme = readTheme();
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(0, 0, this.width, this.height);
      this.layout();
      this.fitLeftPadding();
      this.drawContent(pr);
      this.drawMessage();
    }

    redraw() {
      this.render(this.progress);
    }

    /** Перемальовування не частіше за один раз на кадр. */
    requestRedraw() {
      if (this.redrawQueued || this.cancelAnim) return; // під час анімації кадри й так малюються
      this.redrawQueued = true;
      requestAnimationFrame(() => {
        this.redrawQueued = false;
        this.redraw();
      });
    }

    /** Анімація появи. Межі осей зафіксовані заздалегідь, тож графік не «стрибає». */
    animate() {
      if (this.cancelAnim) this.cancelAnim();
      this.progress = 0;
      let finished = false;
      const cancel = Approx.Animation.animate(ANIM_DURATION, (p) => {
        this.progress = p;
        this.render(p);
      }, () => {
        finished = true;
        this.cancelAnim = null;
      });
      // При prefers-reduced-motion animate() завершується синхронно й уже викликав onDone:
      // не можна після цього записувати cancel, інакше cancelAnim «застрягне» і
      // requestRedraw() назавжди ігноруватиме зміну розміру, легенду й підказки
      if (!finished) this.cancelAnim = cancel;
    }

    // ----- Підказка -----

    pointerPos(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    }

    /** Що під курсором — визначають нащадки. */
    hitTest() { return null; }

    /** HTML підказки — визначають нащадки. */
    tooltipHtml() { return ''; }

    onPointerMove(e) {
      if (this.frame) { this.canvas.style.cursor = 'default'; return; }
      const pos = this.pointerPos(e);
      if (this.legendHit && this.legendHit(pos.mx, pos.my)) {
        this.canvas.style.cursor = 'pointer';
        this.setHover(null);
        return;
      }
      this.canvas.style.cursor = 'crosshair';
      const hit = this.hitTest(pos.mx, pos.my);
      this.setHover(hit);
      if (hit) this.showTooltip(this.tooltipHtml(hit), e.clientX, e.clientY);
    }

    onPointerLeave() {
      this.setHover(null);
    }

    onClick() {}

    setHover(hit) {
      const changed = JSON.stringify(hit) !== JSON.stringify(this.hover);
      this.hover = hit;
      if (!hit) this.hideTooltip();
      if (changed) this.requestRedraw();
    }

    showTooltip(html, clientX, clientY) {
      const tip = this.tooltip;
      if (!tip || !html) return;
      tip.innerHTML = html;
      tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let left = clientX + 14, top = clientY + 14;
      if (left + w > window.innerWidth - 8) left = clientX - w - 14;
      if (top + h > window.innerHeight - 8) top = clientY - h - 14;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = Math.max(8, top) + 'px';
    }

    hideTooltip() {
      if (this.tooltip) this.tooltip.hidden = true;
    }
  }

  // ======================================================================
  // Plot — точки даних і криві моделей
  // ======================================================================

  /**
   * @typedef {Object} CurveSpec
   * @property {string} key — ідентифікатор серії (для перемикання видимості)
   * @property {string} label — підпис у легенді, напр. «L₄(x)»
   * @property {string} [fnName] — позначення в підказці, напр. «L(x)»
   * @property {function(number):number} fn — модель
   * @property {string} [color] — ключ кольору теми: 'curve' | 'lsq'
   */

  class Plot extends BaseChart {
    constructor(canvas, options) {
      super(canvas, options);
      this.points = [];
      this.curves = [];          // [{...CurveSpec, samples}]
      this.residuals = null;     // {curveKey, values}: штрихи від точки до кривої
      this.hidden = new Set();   // ключі серій, вимкнених кліком по легенді
      this.dataRange = { a: 0, b: 0 };
      this.legendItems = [];     // [{key, kind, label, color, x, y, w}]
      this.tailsClipped = false; // хвости екстраполяції обрізано по y
    }

    /**
     * Задає дані графіка; межі осей перераховуються одразу (до анімації).
     * @param {Object} d
     * @param {Array<{x:number,y:number}>} d.points
     * @param {CurveSpec[]} [d.curves]
     * @param {{curveKey:string, values:number[]}|null} [d.residuals]
     * @param {string} [d.message]
     */
    setData(d) {
      this.points = (d.points || []).slice();
      this.residuals = d.residuals || null;
      this.message = d.message || '';
      this.hover = null;

      const xs = this.points.map(function (p) { return p.x; });
      const a = xs.length ? Math.min.apply(null, xs) : -1;
      const b = xs.length ? Math.max.apply(null, xs) : 1;
      this.dataRange = { a: a, b: b };
      const spanX = (b - a) || 1;
      const viewA = a - PAD_FRACTION * spanX;
      const viewB = b + PAD_FRACTION * spanX;

      // Дискретизуємо на всьому видимому відрізку, включно з межами даних a і b
      const grid = sampleGrid(viewA, viewB, CURVE_SAMPLES, [a, b]);
      this.grid = grid; // ті самі x використовує animation.js для проміжних кривих
      this.curves = (d.curves || []).filter(function (c) { return typeof c.fn === 'function'; }).map(function (c) {
        return Object.assign({ color: 'curve', fnName: c.label }, c, {
          samples: grid.map(function (x) { return { x: x, y: c.fn(x) }; })
        });
      });
      this.autoscale();
    }

    isVisible(key) { return !this.hidden.has(key); }

    /**
     * Вмикає або вимикає серію ('points', 'residuals' чи key кривої) і перераховує масштаб.
     * @param {string} key
     * @param {boolean} visible
     */
    setSeriesVisible(key, visible) {
      if (visible) this.hidden.delete(key);
      else this.hidden.add(key);
      this.autoscale();
      this.requestRedraw();
      // Підпис над графіком (напр. «екстраполяцію обрізано») залежить від видимих серій
      this.canvas.dispatchEvent(new CustomEvent('chart:series', { detail: { key: key, visible: visible } }));
    }

    visibleCurves() {
      return this.curves.filter((c) => this.isVisible(c.key));
    }

    /** Чи лежить x у зоні екстраполяції (за межами вузлів). */
    isExtrapolation(x) {
      const r = this.dataRange, eps = 1e-12 * Math.max(1, Math.abs(r.b - r.a));
      return x < r.a - eps || x > r.b + eps;
    }

    /**
     * Межі осей для заданого вмісту: min/max по точках і кривих + 10 % відступу.
     * Значення кривих усередині відрізка даних враховуються повністю, хвости
     * екстраполяції — з обмеженням EXTRAP_CAP · розмах.
     * Чиста функція: нічого не змінює; її ж використовує animation.js для кадрів.
     * @param {Array<{x:number,y:number}>} points
     * @param {Array<Array<{x:number,y:number}>>} sampleArrays — дискретизовані криві
     * @returns {{bounds:Object, tailsClipped:boolean}}
     */
    computeBounds(points, sampleArrays) {
      const r = this.dataRange;
      const spanX = (r.b - r.a) || 1;

      let lo = Infinity, hi = -Infinity;
      points.forEach(function (p) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); });
      let extLo = Infinity, extHi = -Infinity;
      sampleArrays.forEach((samples) => {
        samples.forEach((s) => {
          if (!Number.isFinite(s.y)) return;
          if (this.isExtrapolation(s.x)) { extLo = Math.min(extLo, s.y); extHi = Math.max(extHi, s.y); }
          else { lo = Math.min(lo, s.y); hi = Math.max(hi, s.y); }
        });
      });
      if (!Number.isFinite(lo)) { lo = -1; hi = 1; }

      let span = hi - lo;
      // Розкид на рівні округлень (напр. МНК на сталих y дає ±1e-16) — це «сталі» дані:
      // без цього масштаб провалюється в шум, а сітка мала б ~1e16 поділок
      if (!(span > FLAT_RTOL * Math.max(Math.abs(lo), Math.abs(hi)))) {
        const mid = (lo + hi) / 2;
        span = mid !== 0 ? Math.abs(mid) * 0.2 : 1;
        lo = mid - span / 2;
        hi = mid + span / 2;
      }

      let tailsClipped = false;
      if (Number.isFinite(extLo)) {
        const capLo = lo - EXTRAP_CAP * span;
        const capHi = hi + EXTRAP_CAP * span;
        if (extLo < capLo || extHi > capHi) tailsClipped = true;
        lo = Math.min(lo, Math.max(extLo, capLo));
        hi = Math.max(hi, Math.min(extHi, capHi));
      }

      const padY = PAD_FRACTION * (hi - lo);
      return {
        bounds: {
          xMin: r.a - PAD_FRACTION * spanX,
          xMax: r.b + PAD_FRACTION * spanX,
          yMin: lo - padY,
          yMax: hi + padY
        },
        tailsClipped: tailsClipped
      };
    }

    /** Автомасштаб за видимими точками й видимими кривими. */
    autoscale() {
      const curves = this.visibleCurves();
      const points = (this.isVisible('points') || !curves.length) ? this.points : [];
      const res = this.computeBounds(points, curves.map(function (c) { return c.samples; }));
      this.bounds = res.bounds;
      this.tailsClipped = res.tailsClipped;
    }

    // ----- Легенда -----

    /** Розкладає елементи легенди по рядках і задає верхній відступ. */
    layout() {
      const ctx = this.ctx;
      ctx.font = this.theme.font;
      const items = [{ key: 'points', kind: 'point', label: 'Дані' }];
      const frameLabel = this.frame && this.frame.curveLabel;
      this.curves.forEach(function (c) {
        items.push({ key: c.key, kind: 'line', label: frameLabel || c.label, color: c.color });
      });
      if (this.residuals) items.push({ key: 'residuals', kind: 'stem', label: 'Залишки' });
      items.push({ key: null, kind: 'extrap', label: 'Екстраполяція' });

      const maxX = this.width - 8;
      let x = this.padding.left, row = 0;
      items.forEach(function (it) {
        it.w = 22 + ctx.measureText(it.label).width;
        if (x + it.w > maxX && x > this.padding.left) { row++; x = this.padding.left; }
        it.x = x;
        it.y = 6 + row * LEGEND_ROW + LEGEND_ROW / 2;
        x += it.w + 14;
      }, this);
      this.legendItems = items;
      this.padding.top = 6 + (row + 1) * LEGEND_ROW + 8;
    }

    drawLegend() {
      const ctx = this.ctx, th = this.theme;
      ctx.font = th.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      this.legendItems.forEach((it) => {
        const off = it.key && !this.isVisible(it.key);
        ctx.save();
        ctx.globalAlpha = off ? 0.35 : 1;
        const y = it.y;
        if (it.kind === 'point') {
          ctx.beginPath();
          ctx.arc(it.x + 8, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = th.point;
          ctx.fill();
        } else if (it.kind === 'line') {
          ctx.beginPath();
          ctx.moveTo(it.x, y + 0.5);
          ctx.lineTo(it.x + 16, y + 0.5);
          ctx.lineWidth = 2.4;
          ctx.strokeStyle = th[it.color] || th.curve;
          ctx.stroke();
        } else if (it.kind === 'stem') {
          ctx.beginPath();
          ctx.moveTo(it.x + 8, y - 6);
          ctx.lineTo(it.x + 8, y + 6);
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = th.residual;
          ctx.stroke();
        } else {
          this.fillExtrapolation(it.x, y - 6, 16, 12);
          ctx.strokeStyle = th.extrapLine;
          ctx.lineWidth = 1;
          ctx.strokeRect(it.x + 0.5, y - 5.5, 15, 11);
        }
        ctx.fillStyle = th.text;
        ctx.fillText(it.label, it.x + 22, y);
        if (off) { // перекреслення вимкненої серії
          const tw = ctx.measureText(it.label).width;
          ctx.beginPath();
          ctx.moveTo(it.x + 22, y + 0.5);
          ctx.lineTo(it.x + 22 + tw, y + 0.5);
          ctx.strokeStyle = th.text;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    /** Елемент легенди, на який можна клікнути (зона екстраполяції не перемикається). */
    legendHit(mx, my) {
      return this.legendItems.find(function (it) {
        return it.key && mx >= it.x - 2 && mx <= it.x + it.w + 2 && Math.abs(my - it.y) <= LEGEND_ROW / 2;
      }) || null;
    }

    onClick(e) {
      if (this.frame) return;
      const pos = this.pointerPos(e);
      const it = this.legendHit(pos.mx, pos.my);
      if (it) this.setSeriesVisible(it.key, !this.isVisible(it.key));
    }

    // ----- Малювання -----

    /** Затінення з діагональним штрихуванням (зона екстраполяції). */
    fillExtrapolation(x, y, w, h) {
      const ctx = this.ctx;
      if (w <= 0 || h <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = this.theme.extrapBg;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this.theme.extrapLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let s = -h; s < w; s += 7) {
        ctx.moveTo(x + s, y + h);
        ctx.lineTo(x + s + h, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    drawExtrapolationZones() {
      if (!this.points.length) return;
      const p = this.padding;
      const left = this.toPx(this.dataRange.a, 0).px;
      const right = this.toPx(this.dataRange.b, 0).px;
      this.fillExtrapolation(p.left, p.top, left - p.left, this.plotH);
      this.fillExtrapolation(right, p.top, p.left + this.plotW - right, this.plotH);
    }

    /** Крива до частки progress: суцільна між вузлами, пунктирна в зоні екстраполяції. */
    drawCurve(c, progress) {
      if (progress <= 0) return;
      const ctx = this.ctx, b = this.bounds;
      const xLimit = b.xMin + (b.xMax - b.xMin) * progress;
      const clampPy = function (py) { return Math.max(-PY_LIMIT, Math.min(PY_LIMIT, py)); };

      this.clipToPlot();
      ctx.strokeStyle = this.theme[c.color] || this.theme.curve;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      let run = [];
      let runExt = null;
      const flush = function () {
        if (run.length > 1) {
          ctx.setLineDash(runExt ? [6, 5] : []);
          ctx.beginPath();
          run.forEach(function (pt, i) { if (i) ctx.lineTo(pt.px, pt.py); else ctx.moveTo(pt.px, pt.py); });
          ctx.stroke();
        }
      };
      const push = (x, y) => {
        if (!Number.isFinite(y)) { flush(); run = []; runExt = null; return; }
        const ext = this.isExtrapolation(x);
        const pt = this.toPx(x, y);
        pt.py = clampPy(pt.py);
        if (runExt !== null && ext !== runExt) {
          const last = run[run.length - 1];
          flush();
          run = last ? [last] : [];
        }
        runExt = ext;
        run.push(pt);
      };

      for (let i = 0; i < c.samples.length; i++) {
        const s = c.samples[i];
        if (s.x > xLimit) { if (c.fn) push(xLimit, c.fn(xLimit)); break; }
        push(s.x, s.y);
      }
      flush();
      ctx.restore();
    }

    /** Штрихи залишків: від точки даних до кривої моделі. */
    drawResidualStems(progress) {
      if (!this.residuals || !this.isVisible('residuals') || progress <= 0) return;
      const ctx = this.ctx;
      this.clipToPlot();
      ctx.strokeStyle = this.theme.residual;
      ctx.globalAlpha = progress;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      this.points.forEach((pt, i) => {
        const fitted = pt.y - this.residuals.values[i];
        const a = this.toPx(pt.x, pt.y);
        const c = this.toPx(pt.x, fitted);
        const px = Math.round(a.px) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, a.py);
        ctx.lineTo(px, c.py);
        ctx.stroke();
      });
      ctx.restore();
    }

    /** Точки «виростають» по черзі зліва направо. */
    drawPoints(progress) {
      if (!this.isVisible('points')) return;
      const ctx = this.ctx, th = this.theme;
      const n = this.points.length;
      this.clipToPlot();
      this.points.forEach((pt, i) => {
        const start = n > 1 ? (i / (n - 1)) * 0.6 : 0;
        const t = Math.max(0, Math.min(1, (progress - start) / 0.3));
        if (t <= 0) return;
        const hovered = this.hover && this.hover.index === i;
        const c = this.toPx(pt.x, pt.y);
        // Без світлого обідка: на щільних наборах обідки «розрізали» б криву
        // і вона виглядала б пунктирною (а пунктир означає екстраполяцію)
        ctx.beginPath();
        ctx.arc(c.px, c.py, (hovered ? 6 : 4.2) * t, 0, Math.PI * 2);
        ctx.fillStyle = th.point;
        ctx.fill();
      });
      ctx.restore();
    }

    /** Стрілки ↑/↓ у кутах, якщо хвости екстраполяції виходять за межі осі y. */
    drawClipMarks() {
      if (!this.tailsClipped) return;
      const ctx = this.ctx, b = this.bounds, p = this.padding;
      const marks = [];
      this.visibleCurves().forEach((c) => {
        c.samples.forEach((s) => {
          if (!this.isExtrapolation(s.x) || !Number.isFinite(s.y)) return;
          const side = s.x < this.dataRange.a ? 'left' : 'right';
          if (s.y > b.yMax) marks.push(side + '-up');
          if (s.y < b.yMin) marks.push(side + '-down');
        });
      });
      ctx.font = this.theme.fontBold;
      ctx.fillStyle = this.theme.text;
      ctx.textAlign = 'center';
      Array.from(new Set(marks)).forEach((m) => {
        const x = m.indexOf('left') === 0 ? p.left + 9 : p.left + this.plotW - 9;
        const up = m.indexOf('up') > 0;
        ctx.textBaseline = up ? 'top' : 'bottom';
        ctx.fillText(up ? '↑' : '↓', x, up ? p.top + 3 : p.top + this.plotH - 3);
      });
    }

    /** Вертикальна напрямна й маркери на кривих у точці наведення. */
    drawHover() {
      if (!this.hover) return;
      const ctx = this.ctx, p = this.padding, th = this.theme;
      const x = this.hover.x;
      const px = Math.round(this.toPx(x, 0).px) + 0.5;
      this.clipToPlot();
      ctx.strokeStyle = th.guide;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, p.top);
      ctx.lineTo(px, p.top + this.plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      this.visibleCurves().forEach((c) => {
        const y = c.fn(x);
        if (!Number.isFinite(y)) return;
        const pt = this.toPx(x, y);
        ctx.beginPath();
        ctx.arc(pt.px, pt.py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = th.bg;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = th[c.color] || th.curve;
        ctx.stroke();
      });
      ctx.restore();
    }

    // ----- Малювання кадру анімації -----

    /**
     * Точки кадру: 'ghost' — ще не додані (контур), 'new' — щойно доданий вузол
     * (колір виділення, більший радіус, ореол), 'normal' — звичайні.
     * @param {Array<{x:number,y:number,state:string,r?:number,halo?:number}>} points
     */
    drawFramePoints(points) {
      const ctx = this.ctx, th = this.theme;
      this.clipToPlot();
      points.forEach((pt) => {
        const c = this.toPx(pt.x, pt.y);
        const r = pt.r === undefined ? 4.2 : pt.r;
        if (r <= 0) return;
        ctx.setLineDash([]);
        if (pt.state === 'ghost') {
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = th.point;
          ctx.stroke();
          ctx.globalAlpha = 1;
          return;
        }
        const color = pt.state === 'new' ? th.highlight : th.point;
        if (pt.halo > 0) {
          ctx.globalAlpha = 0.3 * pt.halo;
          ctx.beginPath();
          ctx.arc(c.px, c.py, r + 7 * pt.halo, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
      ctx.restore();
    }

    /** Відрізки залишків кадру: від (xᵢ, ŷᵢ) до поточного кінця; той, що росте, — виділений. */
    drawFrameStems(stems) {
      const ctx = this.ctx, th = this.theme;
      this.clipToPlot();
      stems.forEach((st) => {
        if (st.y1 === st.y0) return;
        const a = this.toPx(st.x, st.y0);
        const b = this.toPx(st.x, st.y1);
        const px = Math.round(a.px) + 0.5;
        ctx.strokeStyle = st.highlight ? th.highlight : th.residual;
        ctx.lineWidth = st.highlight ? 2.4 : 1.4;
        ctx.setLineDash(st.highlight ? [] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(px, a.py);
        ctx.lineTo(px, b.py);
        ctx.stroke();
        if (st.highlight) { // «голова» відрізка, що зараз росте
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(px, b.py, 3, 0, Math.PI * 2);
          ctx.fillStyle = th.highlight;
          ctx.fill();
        }
      });
      ctx.restore();
    }

    drawFrame(f) {
      this.drawExtrapolationZones();
      this.drawGrid();
      this.drawAxes();
      this.drawFrameStems(f.stems || []);
      if (f.curve && f.curve.alpha > 0) {
        this.ctx.save();
        this.ctx.globalAlpha = f.curve.alpha;
        this.drawCurve({ samples: f.curve.samples, color: f.curve.color }, 1);
        this.ctx.restore();
      }
      this.drawFramePoints(f.points || []);
      this.drawLegend();
    }

    drawContent(progress) {
      if (this.frame) { this.drawFrame(this.frame); return; }
      this.drawExtrapolationZones();
      this.drawGrid();
      this.drawAxes();
      this.drawResidualStems(progress);
      this.visibleCurves().forEach((c) => this.drawCurve(c, progress));
      this.drawPoints(progress);
      this.drawHover();
      this.drawClipMarks();
      this.drawLegend();
    }

    // ----- Підказка -----

    /**
     * Біля точки даних — «прилипаємо» до неї (показуємо похибку),
     * інакше — значення моделей при x під курсором.
     */
    hitTest(mx, my) {
      let best = null, bestDist = SNAP_RADIUS;
      if (this.isVisible('points')) {
        this.points.forEach((pt, i) => {
          const c = this.toPx(pt.x, pt.y);
          const d = Math.hypot(c.px - mx, c.py - my);
          if (d <= bestDist) { bestDist = d; best = { index: i, x: pt.x }; }
        });
      }
      if (best) return best;
      if (!this.insidePlot(mx, my) || !this.visibleCurves().length) return null;
      return { index: -1, x: this.fromPx(mx, my).x };
    }

    tooltipHtml(hit) {
      const fv = formatValue;
      const lines = [];
      const curves = this.visibleCurves();
      if (hit.index >= 0) {
        const pt = this.points[hit.index];
        lines.push('<strong>Точка ' + (hit.index + 1) + '</strong>');
        lines.push('x = ' + fv(pt.x) + ', y = ' + fv(pt.y));
        curves.forEach(function (c) {
          const model = c.fn(pt.x);
          lines.push(escapeHtml(c.fnName) + ' = ' + fv(model));
          lines.push('похибка y − ' + escapeHtml(c.fnName) + ' = ' + fv(pt.y - model));
        });
      } else {
        lines.push('<strong>x = ' + fv(hit.x) + '</strong>' +
          (this.isExtrapolation(hit.x) ? ' · <em>екстраполяція</em>' : ''));
        curves.forEach(function (c) {
          lines.push(escapeHtml(c.fnName) + ' = ' + fv(c.fn(hit.x)));
        });
      }
      return lines.join('<br>');
    }
  }

  // ======================================================================
  // ResidualPlot — діаграма залишків МНК
  // ======================================================================

  class ResidualPlot extends BaseChart {
    constructor(canvas, options) {
      super(canvas, Object.assign({ xLabel: 'x', yLabel: 'r = y − ŷ' }, options));
      this.points = [];
      this.residuals = [];
      this.fitted = [];
      this.rmse = 0;
      this.negligible = false; // залишки ≈ 0 (поліном проходить через усі точки)
    }

    /**
     * @param {Object} d
     * @param {Array<{x:number,y:number}>} d.points
     * @param {number[]} d.residuals — rᵢ = yᵢ − ŷᵢ
     * @param {number[]} d.fitted — ŷᵢ
     * @param {number} d.rmse
     * @param {number} [d.degree] — степінь МНК
     * @param {string} [d.message]
     */
    setData(d) {
      this.points = (d.points || []).slice();
      this.residuals = (d.residuals || []).slice();
      this.fitted = (d.fitted || []).slice();
      this.rmse = d.rmse || 0;
      this.degree = d.degree; // степінь m — щоб відрізнити «m = n − 1» від інших нульових залишків
      this.message = d.message || '';
      this.hover = null;
      this.autoscale();
    }

    /** Симетрично відносно r = 0: ±max(|r|, RMSE) + 10 %. */
    autoscale() {
      const xs = this.points.map(function (p) { return p.x; });
      const a = xs.length ? Math.min.apply(null, xs) : -1;
      const b = xs.length ? Math.max.apply(null, xs) : 1;
      const spanX = (b - a) || 1;

      let maxAbs = this.rmse;
      this.residuals.forEach(function (r) { if (Number.isFinite(r)) maxAbs = Math.max(maxAbs, Math.abs(r)); });
      let yScale = 0;
      this.points.forEach(function (p) { yScale = Math.max(yScale, Math.abs(p.y)); });

      // Залишки на рівні похибок округлення — модель інтерполює дані
      this.negligible = this.residuals.length > 0 && maxAbs <= 1e-9 * Math.max(1, yScale);
      if (this.negligible && !this.message) {
        this.message = this.points.length === this.degree + 1
          ? 'Залишки ≈ 0: m = n − 1, поліном проходить через усі точки'
          : 'Залишки ≈ 0: поліном точно описує дані';
      }
      const half = this.negligible || !(maxAbs > 0) ? 1 : maxAbs * (1 + PAD_FRACTION);
      this.bounds = {
        xMin: a - PAD_FRACTION * spanX,
        xMax: b + PAD_FRACTION * spanX,
        yMin: -half,
        yMax: half
      };
    }

    layout() {
      this.padding.top = 14;
      this.padding.right = 58; // місце для підписів r = 0 і ±RMSE праворуч від області графіка
    }

    /**
     * Лінія r = 0 (суцільна) і ±RMSE (пунктирні). Підписи стоять праворуч,
     * поза областю графіка, — штрихи й маркери їх не перекривають.
     */
    drawReferenceLines(rmseAlpha) {
      const ctx = this.ctx, p = this.padding, th = this.theme, b = this.bounds;
      const alpha = rmseAlpha === undefined ? 1 : rmseAlpha;
      const right = p.left + this.plotW;
      const zeroY = Math.round(this.toPx(0, 0).py) + 0.5;
      const label = (text, y, color, bold) => {
        ctx.font = bold ? th.fontBold : th.font;
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, right + 6, y);
      };

      if (this.rmse > 0 && !this.negligible && this.rmse < b.yMax && alpha > 0) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = th.guide;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        [this.rmse, -this.rmse].forEach((v) => {
          const py = Math.round(this.toPx(0, v).py) + 0.5;
          ctx.beginPath();
          ctx.moveTo(p.left, py);
          ctx.lineTo(right + 4, py);
          ctx.stroke();
        });
        ctx.restore();
        // Якщо смуга вузька, підписи ±RMSE зсуваються від r = 0, щоб не налізти
        const gap = 14;
        ctx.save();
        ctx.globalAlpha = alpha;
        label('+RMSE', Math.min(this.toPx(0, this.rmse).py, zeroY - gap), th.text);
        label('−RMSE', Math.max(this.toPx(0, -this.rmse).py, zeroY + gap), th.text);
        ctx.restore();
      }

      ctx.strokeStyle = th.zero;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(p.left, zeroY);
      ctx.lineTo(right + 4, zeroY);
      ctx.stroke();
      label('r = 0', zeroY, th.zero, true);
    }

    /** Штрихи від r = 0 до rᵢ і маркери; під час анімації штрихи «виростають». */
    drawStems(progress) {
      const ctx = this.ctx, th = this.theme;
      if (this.negligible) return;
      this.clipToPlot();
      this.points.forEach((pt, i) => {
        const r = this.residuals[i] * progress;
        const base = this.toPx(pt.x, 0);
        const tip = this.toPx(pt.x, r);
        const px = Math.round(base.px) + 0.5;
        const hovered = this.hover && this.hover.index === i;
        ctx.strokeStyle = th.residual;
        ctx.lineWidth = hovered ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(px, base.py);
        ctx.lineTo(px, tip.py);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, tip.py, hovered ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = th.residual;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.bg;
        ctx.stroke();
      });
      ctx.restore();
    }

    /**
     * Штрихи кадру анімації: від r = 0 (тобто від ŷᵢ) до поточної довжини.
     * @param {Array<{x:number, r:number, highlight?:boolean}>} stems
     */
    drawFrameStems(stems) {
      const ctx = this.ctx, th = this.theme;
      this.clipToPlot();
      stems.forEach((st) => {
        if (!st.r) return;
        const base = this.toPx(st.x, 0);
        const tip = this.toPx(st.x, st.r);
        const px = Math.round(base.px) + 0.5;
        const color = st.highlight ? th.highlight : th.residual;
        ctx.strokeStyle = color;
        ctx.lineWidth = st.highlight ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(px, base.py);
        ctx.lineTo(px, tip.py);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, tip.py, st.highlight ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.bg;
        ctx.stroke();
      });
      ctx.restore();
    }

    drawContent(progress) {
      this.drawGrid();
      this.drawAxes();
      if (this.frame) {
        this.drawReferenceLines(this.frame.rmseAlpha);
        if (!this.negligible) this.drawFrameStems(this.frame.stems || []);
        return;
      }
      this.drawReferenceLines();
      this.drawStems(progress);
    }

    /** Найближча за x точка (штрихи вузькі — наводитися по x зручніше). */
    hitTest(mx, my) {
      if (!this.insidePlot(mx, my) || !this.points.length || this.negligible) return null;
      let best = -1, bestDist = Infinity;
      this.points.forEach((pt, i) => {
        const d = Math.abs(this.toPx(pt.x, 0).px - mx);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      return bestDist <= Math.max(SNAP_RADIUS, this.plotW / this.points.length / 2) ? { index: best, x: this.points[best].x } : null;
    }

    tooltipHtml(hit) {
      const fv = formatValue;
      const i = hit.index;
      const pt = this.points[i];
      const r = this.residuals[i];
      const lines = [
        '<strong>Точка ' + (i + 1) + '</strong>',
        'x = ' + fv(pt.x),
        'y = ' + fv(pt.y) + ', ŷ = ' + fv(this.fitted[i]),
        'r = y − ŷ = ' + fv(r)
      ];
      if (this.rmse > 0) lines.push('|r| / RMSE = ' + fv(Math.abs(r) / this.rmse, 3));
      return lines.join('<br>');
    }

  }

  // ======================================================================
  // ChartMode — перемикач «Інтерполяція / МНК / Усі»
  // ======================================================================

  const ChartMode = {
    MODES: ['interp', 'lsq', 'all'],

    /**
     * Показує елементи з data-mode, що відповідають режиму; решту ховає.
     * Приховані полотна не малюються, а коли стають видимими — перемальовуються
     * автоматично (ResizeObserver бачить зміну розміру з 0).
     * @param {'interp'|'lsq'|'all'} mode
     * @param {ParentNode} [root=document]
     */
    apply(mode, root) {
      const m = this.MODES.indexOf(mode) >= 0 ? mode : 'all';
      (root || document).querySelectorAll('[data-mode]').forEach(function (el) {
        el.hidden = !(m === 'all' || el.dataset.mode === m);
      });
      return m;
    }
  };

  Approx.Plot = Plot;
  Approx.ResidualPlot = ResidualPlot;
  Approx.ChartMode = ChartMode;
  Approx.niceStep = niceStep;
  Approx.niceTicks = niceTicks;
  Approx.formatTick = formatTick;
  Approx.formatValue = formatValue;
})(window.Approx = window.Approx || {});
