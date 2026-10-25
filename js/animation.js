/**
 * animation.js — анімації на requestAnimationFrame.
 *
 * Вміст:
 *  - easing, animate()   — функції згладжування і проста анімація появи (для plot.js);
 *  - Timeline             — шкала часу з паузою: час іде лише під час відтворення;
 *  - smoothDamp, BoundsFollower — плавне підлаштування меж осей на кожному кадрі;
 *  - createDemo()         — покрокова демонстрація з кнопками «Старт / Пауза / Скидання»:
 *      1) Лагранж: вузли додаються по одному, крива плавно морфується L_{k−1} → L_k,
 *         новий вузол виділено кольором і розміром;
 *      2) МНК: поліном «виростає» з горизонталі y = ȳ інтерполяцією коефіцієнтів
 *         c(s) = (1 − s)·c_ȳ + s·c, s: 0 → 1;
 *      3) залишки: відрізки від (xᵢ, ŷᵢ) до (xᵢ, yᵢ) з'являються по черзі.
 *
 * Графіки (plot.js) нічого не рахують у цьому режимі: контролер обчислює вміст
 * кожного кадру й межі осей і передає їх через chart.setFrame().
 */
(function (Approx) {
  'use strict';

  const MAX_DT = 0.1;         // с: після неактивної вкладки час не «перескакує»
  const EXPAND_TIME = 0.16;   // с: розширення осей — швидко, щоб вміст не втікав за рамку
  const SHRINK_TIME = 0.45;   // с: звуження — повільніше, без «пульсації»
  const SETTLE_MS = 600;      // мс наприкінці: межі встигають зійтися до фінальних

  // ---------- Згладжування ----------

  const clamp01 = function (t) { return t < 0 ? 0 : t > 1 ? 1 : t; };
  const clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  const easing = {
    linear: function (t) { return t; },
    easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    /** З невеликим «перельотом» — для появи вузла. */
    easeOutBack: function (t) {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
  };

  /** Чи просив користувач у системі зменшити анімації. */
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * Проста анімація появи: викликає onFrame з прогресом 0…1 (easeOutCubic).
   * Використовується в plot.js; поважає prefers-reduced-motion.
   * @param {number} duration — мс
   * @param {function(number): void} onFrame
   * @param {function(): void} [onDone]
   * @returns {function(): void} скасування
   */
  function animate(duration, onFrame, onDone) {
    if (duration <= 0 || prefersReducedMotion()) {
      onFrame(1);
      if (onDone) onDone();
      return function () {};
    }
    let start = null, frameId = 0, stopped = false;
    function step(timestamp) {
      if (stopped) return;
      if (start === null) start = timestamp;
      const t = Math.min(1, (timestamp - start) / duration);
      onFrame(easing.easeOutCubic(t));
      if (t < 1) frameId = requestAnimationFrame(step);
      else if (onDone) onDone();
    }
    frameId = requestAnimationFrame(step);
    return function cancel() {
      stopped = true;
      cancelAnimationFrame(frameId);
    };
  }

  // ---------- Шкала часу ----------

  /**
   * Шкала часу на requestAnimationFrame. Час рахується з реальних інтервалів
   * між кадрами (не з кількості кадрів), тож швидкість однакова на 60 і 144 Гц.
   */
  class Timeline {
    /**
     * @param {{duration:number, onUpdate:function(number, number), onEnd?:function()}} opts
     *   onUpdate(timeMs, dtSeconds) викликається на кожному кадрі відтворення.
     */
    constructor(opts) {
      this.duration = opts.duration;
      this.onUpdate = opts.onUpdate;
      this.onEnd = opts.onEnd || null;
      this.time = 0;
      this.playing = false;
      this.raf = 0;
      this.last = null;
    }

    play() {
      if (this.playing) return;
      this.playing = true;
      this.last = null;
      this.raf = requestAnimationFrame((ts) => this.tick(ts));
    }

    pause() {
      this.playing = false;
      cancelAnimationFrame(this.raf);
    }

    reset() {
      this.pause();
      this.time = 0;
    }

    tick(ts) {
      if (!this.playing) return;
      const dt = this.last === null ? 0 : Math.min(MAX_DT, (ts - this.last) / 1000);
      this.last = ts;
      this.time = Math.min(this.duration, this.time + dt * 1000);
      this.onUpdate(this.time, dt);
      if (this.time >= this.duration) {
        this.playing = false;
        if (this.onEnd) this.onEnd();
        return;
      }
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  // ---------- Плавні межі осей ----------

  /**
   * Критично демпфована «пружина» (SmoothDamp): значення наближається до цілі
   * без перерегулювання, а швидкість змінюється неперервно — тому, навіть коли
   * ціль раптом стрибає, межі осей рухаються без ривків.
   * @param {number} current
   * @param {number} target
   * @param {{v:number}} state — поточна швидкість (змінюється)
   * @param {number} smoothTime — приблизний час наближення, с
   * @param {number} dt — крок часу, с
   * @returns {number}
   */
  function smoothDamp(current, target, state, smoothTime, dt) {
    if (!(dt > 0)) return current;
    const omega = 2 / Math.max(1e-4, smoothTime);
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = current - target;
    const temp = (state.v + omega * change) * dt;
    state.v = (state.v - omega * temp) * exp;
    let out = target + (change + temp) * exp;
    if ((target - current > 0) === (out > target)) { // не проскакуємо ціль
      out = target;
      state.v = 0;
    }
    return out;
  }

  const EDGES = ['xMin', 'xMax', 'yMin', 'yMax'];

  /**
   * Межі осей, що плавно слідують за цільовими. Розширюються швидше, ніж звужуються:
   * вміст, що виходить за рамку, швидко повертається в поле зору, а коли крива
   * «заспокоюється», масштаб змінюється повільно і не пульсує.
   */
  class BoundsFollower {
    constructor(initial) {
      this.b = Object.assign({}, initial);
      this.v = {};
      EDGES.forEach((k) => { this.v[k] = { v: 0 }; });
    }

    /**
     * @param {Object} target — цільові межі {xMin, xMax, yMin, yMax}
     * @param {number} dt — с
     * @returns {Object} поточні межі (копія)
     */
    step(target, dt) {
      EDGES.forEach((k) => {
        const cur = this.b[k];
        const t = target[k];
        const expanding = (k === 'xMin' || k === 'yMin') ? t < cur : t > cur;
        this.b[k] = smoothDamp(cur, t, this.v[k], expanding ? EXPAND_TIME : SHRINK_TIME, dt);
      });
      // Захист від виродження (межі не повинні схлопнутися)
      if (!(this.b.xMax > this.b.xMin)) this.b.xMax = this.b.xMin + 1e-9;
      if (!(this.b.yMax > this.b.yMin)) this.b.yMax = this.b.yMin + 1e-9;
      return Object.assign({}, this.b);
    }
  }

  // ---------- Допоміжне ----------

  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const toSub = function (n) { return String(n).split('').map(function (d) { return SUB[+d]; }).join(''); };

  function horner(c, t) {
    let r = 0;
    for (let j = c.length - 1; j >= 0; j--) r = r * t + c[j];
    return r;
  }

  /**
   * Порядок додавання вузлів «від країв до середини»: спершу крайні, далі щоразу
   * вузол, найвіддаленіший від уже доданих. Проміжні поліноми тоді визначені на
   * всьому відрізку і не «вибухають» на краю, як при додаванні зліва направо.
   * @param {number[]} xs
   * @returns {number[]} індекси вузлів у порядку додавання
   */
  function spreadOrder(xs) {
    const n = xs.length;
    const byX = xs.map(function (x, i) { return i; }).sort(function (a, b) { return xs[a] - xs[b]; });
    if (n <= 2) return byX;
    const order = [byX[0], byX[n - 1]];
    const used = new Set(order);
    while (order.length < n) {
      let best = -1, bestDist = -1;
      byX.forEach(function (i) {
        if (used.has(i)) return;
        let d = Infinity;
        order.forEach(function (j) { d = Math.min(d, Math.abs(xs[i] - xs[j])); });
        if (d > bestDist) { bestDist = d; best = i; }
      });
      order.push(best);
      used.add(best);
    }
    return order;
  }

  // ---------- Сцени (вміст кадру як функція часу) ----------

  /**
   * Сцена 1: Лагранж — вузли додаються по одному.
   * Крок k (k = 1…n): k-й вузол «вискакує» з виділенням, крива плавно переходить
   * від полінома через k − 1 вузол до полінома через k вузлів (на тій самій сітці x).
   */
  function lagrangeScene(chart, data) {
    const n = data.xs.length;
    const order = spreadOrder(data.xs);
    const rank = new Array(n);
    order.forEach(function (idx, pos) { rank[idx] = pos; });
    const grid = chart.grid;
    const stepMs = clamp(5000 / n, 300, 900);
    const cache = [];

    /** Значення полінома через перші k вузлів порядку на сітці x (з кешем). */
    function valuesFor(k) {
      if (cache[k]) return cache[k];
      const sx = order.slice(0, k).map(function (i) { return data.xs[i]; });
      const sy = order.slice(0, k).map(function (i) { return data.ys[i]; });
      const fn = k === 1 ? function () { return sy[0]; } : Approx.createLagrange(sx, sy);
      cache[k] = grid.map(fn);
      return cache[k];
    }

    return {
      duration: n * stepMs,
      frame: function (t) {
        const T = clamp(t, 0, n * stepMs);
        const done = t >= n * stepMs;
        const k = done ? n : Math.min(n, Math.floor(T / stepMs) + 1);
        const u = done ? 1 : clamp01(T / stepMs - (k - 1));
        const started = t > 0;

        // Морфінг кривої — перші 70 % кроку, решта — пауза, щоб роздивитися
        const morph = easing.easeInOutCubic(clamp01(u / 0.7));
        const B = valuesFor(k);
        const A = k > 1 ? valuesFor(k - 1) : B;
        const curve = started ? {
          samples: grid.map(function (x, j) { return { x: x, y: A[j] + morph * (B[j] - A[j]) }; }),
          color: 'curve',
          alpha: k === 1 ? morph : 1 // перша «крива» (константа) з'являється плавно
        } : null;

        const pop = easing.easeOutBack(clamp01(u / 0.35));
        const points = data.xs.map(function (x, i) {
          const pos = rank[i];
          if (!started || pos > k - 1) return { x: x, y: data.ys[i], state: 'ghost', r: 4 };
          if (pos === k - 1 && !done) {
            return { x: x, y: data.ys[i], state: 'new', r: 4.2 + 3.6 * pop * (1 - 0.4 * u), halo: 1 - u };
          }
          return { x: x, y: data.ys[i], state: 'normal', r: 4.2 };
        });

        const newX = data.xs[order[k - 1]];
        return {
          points: points,
          curve: curve,
          curveLabel: 'L' + toSub(Math.max(0, k - 1)) + '(x)',
          status: started
            ? 'Лагранж: вузол ' + k + ' з ' + n + ' (x = ' + Approx.formatValue(newX) + '), степінь ' + (k - 1)
            : 'Лагранж: вузли додаються від країв до середини'
        };
      }
    };
  }

  /**
   * Сцена 2: МНК — поліном «виростає» з горизонталі y = ȳ.
   * Коефіцієнти в нормалізованій змінній t: c(s) = (1 − s)·[ȳ, 0, …, 0] + s·c.
   */
  function lsqGrowScene(chart, data) {
    const fit = data.fit;
    const cT = fit.coeffsT;
    const mean = data.ys.reduce(function (a, y) { return a + y; }, 0) / data.ys.length;
    const cMean = cT.map(function (c, j) { return j === 0 ? mean : 0; });
    const grid = chart.grid;
    const ts = grid.map(function (x) { return (x - fit.normalizer.center) / fit.normalizer.half; });
    const duration = 2200;

    return {
      duration: duration,
      frame: function (t) {
        const s = easing.easeInOutCubic(clamp01(t / duration));
        const c = cT.map(function (cj, j) { return (1 - s) * cMean[j] + s * cj; });
        return {
          points: data.xs.map(function (x, i) { return { x: x, y: data.ys[i], state: 'normal' }; }),
          curve: { samples: grid.map(function (x, j) { return { x: x, y: horner(c, ts[j]) }; }), color: 'lsq', alpha: 1 },
          curveLabel: 'P' + toSub(fit.degree) + '(x), МНК',
          status: t <= 0
            ? 'МНК: старт з горизонталі y = ȳ = ' + Approx.formatValue(mean, 4)
            : 'МНК: c(s) = (1 − s)·c_ȳ + s·c,  s = ' + s.toFixed(2)
        };
      }
    };
  }

  /**
   * Сцена 3: залишки з'являються по черзі (зліва направо):
   * відрізок росте від (xᵢ, ŷᵢ) до (xᵢ, yᵢ); на діаграмі залишків — від 0 до rᵢ.
   */
  function residualScene(data) {
    const fit = data.fit;
    const n = data.xs.length;
    const duration = clamp(260 * n, 1500, 4200);
    const grow = duration * 0.3;                // тривалість росту одного відрізка
    const stagger = (duration - grow) / Math.max(1, n - 1);

    function g(i, t) { return easing.easeOutCubic(clamp01((t - i * stagger) / grow)); }

    return {
      duration: duration,
      lsqStems: function (t) {
        return data.xs.map(function (x, i) {
          const gi = g(i, t);
          return { x: x, y0: fit.fitted[i], y1: fit.fitted[i] + gi * fit.residuals[i], highlight: gi > 0 && gi < 1 };
        });
      },
      residFrame: function (t) {
        return {
          stems: data.xs.map(function (x, i) {
            const gi = g(i, t);
            return { x: x, r: gi * fit.residuals[i], highlight: gi > 0 && gi < 1 };
          }),
          rmseAlpha: clamp01(t / (0.3 * duration))
        };
      },
      status: function (t) {
        let shown = 0;
        for (let i = 0; i < n; i++) if (g(i, t) > 0) shown++;
        return 'Залишки rᵢ = yᵢ − ŷᵢ: ' + shown + ' з ' + n;
      }
    };
  }

  // ---------- Контролер демонстрації ----------

  /**
   * Покрокова демонстрація на графіках вкладки «Набір».
   * @param {Object} opts
   * @param {{lagrange: Object, lsq: Object, resid: Object}} opts.charts — Plot, Plot, ResidualPlot
   * @param {function(): {xs:number[], ys:number[], fit:?Object}} opts.getData — дані активного набору
   * @param {{start:HTMLButtonElement, pause:HTMLButtonElement, reset:HTMLButtonElement,
   *          status:HTMLElement, progress:HTMLElement}} opts.ui
   * @returns {{start:function(), pause:function(), reset:function(), state:string}}
   */
  function createDemo(opts) {
    const charts = opts.charts;
    const ui = opts.ui;
    const isShown = function (chart) { return chart.canvas.getClientRects().length > 0; };
    const IDLE_STATUS = 'Покроково: Лагранж → МНК → залишки';

    let state = 'idle';     // 'idle' | 'playing' | 'paused' | 'done'
    let timeline = null;
    let plan = null;
    let lastStatus = '';

    /** Будує план: які сцени і на яких графіках (з урахуванням режиму й видимості). */
    function buildPlan() {
      const data = opts.getData();
      const p = { followers: new Map(), parts: {}, total: 0, note: '' };
      let t = 0;

      // Звичайні межі (без кадру) — стартова точка для плавного переходу
      [charts.lagrange, charts.lsq, charts.resid].forEach(function (c) { c.stopAnimation(); c.clearFrame(); });

      if (isShown(charts.lagrange)) {
        const sc = lagrangeScene(charts.lagrange, data);
        p.parts.lagrange = { start: t, scene: sc };
        t += sc.duration;
      }
      const wantLsq = isShown(charts.lsq) || isShown(charts.resid);
      if (wantLsq && data.fit) {
        const grow = lsqGrowScene(charts.lsq, data);
        p.parts.grow = { start: t, scene: grow };
        t += grow.duration;
        const res = residualScene(data);
        p.parts.resid = { start: t, scene: res };
        t += res.duration;
      } else if (wantLsq) {
        p.note = ' · МНК пропущено: точок замало для m';
      }
      p.total = t + SETTLE_MS;

      const involved = [];
      if (p.parts.lagrange) involved.push(charts.lagrange);
      if (p.parts.grow && isShown(charts.lsq)) involved.push(charts.lsq);
      if (p.parts.resid && isShown(charts.resid)) involved.push(charts.resid);
      p.involved = involved;
      involved.forEach(function (c) { p.followers.set(c, new BoundsFollower(c.bounds)); });
      p.residTarget = Object.assign({}, charts.resid.bounds); // межі залишків не залежать від кадру
      return p;
    }

    /** Подає кадр на графік: межі плавно наближаються до меж поточного вмісту. */
    function present(chart, content, dt) {
      // Серії, вимкнені кліком по легенді, не показуємо й під час анімації
      if (chart.isVisible) {
        if (!chart.isVisible('model')) content.curve = null;
        if (!chart.isVisible('residuals')) content.stems = [];
        if (!chart.isVisible('points')) content.points = [];
      }
      let target;
      if (chart === charts.resid) {
        target = plan.residTarget;
      } else {
        const samples = content.curve ? [content.curve.samples] : [];
        // Межі — за видимим вмістом (точки, зокрема «привиди», і поточна крива);
        // якщо все приховано, — за всіма точками, як і звичайний автомасштаб
        const pts = content.points.length || samples.length ? content.points : chart.points;
        target = chart.computeBounds(pts, samples).bounds;
      }
      content.bounds = plan.followers.get(chart).step(target, dt);
      chart.setFrame(content);
    }

    /** Кадр у момент T (мс від початку). */
    function frameAt(T, dt) {
      const parts = plan.parts;
      let status = '';

      if (parts.lagrange && plan.involved.indexOf(charts.lagrange) >= 0) {
        const f = parts.lagrange.scene.frame(T - parts.lagrange.start);
        present(charts.lagrange, f, dt);
        if (T < parts.lagrange.start + parts.lagrange.scene.duration) status = f.status;
      }

      if (parts.grow) {
        const local = T - parts.grow.start;
        const f = parts.grow.scene.frame(local);
        const rLocal = T - parts.resid.start;
        if (plan.involved.indexOf(charts.lsq) >= 0) {
          f.stems = rLocal > 0 ? parts.resid.scene.lsqStems(rLocal) : [];
          present(charts.lsq, f, dt);
        }
        if (plan.involved.indexOf(charts.resid) >= 0) {
          const rf = rLocal > 0 ? parts.resid.scene.residFrame(rLocal) : { stems: [], rmseAlpha: 0 };
          present(charts.resid, rf, dt);
        }
        if (!status && local >= 0 && rLocal < 0) status = f.status;
        if (!status && rLocal >= 0) status = parts.resid.scene.status(rLocal);
      }

      if (T >= plan.total - SETTLE_MS) status = 'Готово' + plan.note;
      setStatus(status + (T < plan.total - SETTLE_MS ? plan.note : ''), T / plan.total);
    }

    function setStatus(text, fraction) {
      if (text !== lastStatus) {
        ui.status.textContent = text;
        lastStatus = text;
      }
      const pct = Math.round(clamp01(fraction) * 100);
      ui.progress.style.width = pct + '%';
      if (ui.progress.parentNode) ui.progress.parentNode.setAttribute('aria-valuenow', String(pct));
    }

    function updateButtons() {
      ui.start.disabled = state === 'playing';
      ui.pause.disabled = state !== 'playing';
      ui.reset.disabled = state === 'idle';
      ui.start.textContent = state === 'paused' ? '▶ Продовжити' : state === 'done' ? '▶ Ще раз' : '▶ Старт';
    }

    function finish() {
      state = 'done';
      // Межі вже зійшлися до фінальних (SETTLE_MS) — повертаємо звичайне малювання з підказками
      plan.involved.forEach(function (c) { c.clearFrame(); });
      setStatus('Готово' + plan.note, 1);
      updateButtons();
    }

    function start() {
      if (state === 'playing') return;
      if (state === 'paused' && timeline) {
        state = 'playing';
        timeline.play();
        updateButtons();
        return;
      }
      plan = buildPlan();
      if (!plan.involved.length) {
        setStatus('Немає видимих графіків для анімації' + plan.note, 0);
        return;
      }
      timeline = new Timeline({ duration: plan.total, onUpdate: frameAt, onEnd: finish });
      frameAt(0, 0); // перший кадр одразу (межі ще старі — далі плавно)
      state = 'playing';
      timeline.play();
      updateButtons();
    }

    function pause() {
      if (state !== 'playing') return;
      timeline.pause();
      state = 'paused';
      updateButtons();
    }

    function reset() {
      if (timeline) timeline.reset();
      timeline = null;
      if (plan) plan.involved.forEach(function (c) { c.clearFrame(); });
      plan = null;
      state = 'idle';
      setStatus(IDLE_STATUS, 0);
      updateButtons();
    }

    ui.start.addEventListener('click', start);
    ui.pause.addEventListener('click', pause);
    ui.reset.addEventListener('click', reset);
    setStatus(IDLE_STATUS, 0);
    updateButtons();

    return {
      start: start,
      pause: pause,
      reset: reset,
      get state() { return state; }
    };
  }

  Approx.Animation = {
    animate: animate,
    easing: easing,
    Timeline: Timeline,
    smoothDamp: smoothDamp,
    BoundsFollower: BoundsFollower,
    spreadOrder: spreadOrder,
    createDemo: createDemo
  };
})(window.Approx = window.Approx || {});
