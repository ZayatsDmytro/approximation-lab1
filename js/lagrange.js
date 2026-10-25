/**
 * lagrange.js — інтерполяційні поліноми Лагранжа і Ньютона.
 *
 * Нормалізація. Усі обчислення ведуться у змінній t ∈ [−1, 1]:
 *     t = (x − c) / h,   c = (a + b) / 2,   h = (b − a) / 2,
 * де [a, b] — відрізок, на якому лежать вузли.
 * Що це дає:
 *  - добутки Π(t − tⱼ) обмежені значенням 2ⁿ⁻¹, тож чисельник і знаменник
 *    базисного полінома можна рахувати окремо без ризику переповнення
 *    навіть при великих n чи широкому діапазоні x, а знаменники — один раз;
 *  - поділені різниці в t не залежать від одиниць вимірювання x.
 * Чого це НЕ дає:
 *  - Лагранж інваріантний до лінійної заміни змінної: відношення
 *    (x − xⱼ)/(xₖ − xⱼ) однакові в x і в t, тож точність та сама;
 *  - на даних варіанту 14 похибка у вузлах і так ~1e−12 і нижче з нормалізацією та без;
 *  - від осциляцій на рівновіддалених вузлах (ефект Рунге на 20 точках)
 *    нормалізація не рятує — це властивість самої задачі, а не округлень.
 * Значення полінома від нормалізації не змінюється: L(x) = L̃(t(x)).
 *
 * Форми обчислення:
 *  - Лагранж — модифікована (перша барицентрична) форма
 *        p(t) = ℓ(t) · Σ wₖ·yₖ / (t − tₖ),  ℓ(t) = Π (t − tⱼ),  wₖ = 1 / Π_{j≠k} (tₖ − tⱼ).
 *    Це та сама формула p(x) = Σ yₖ·Lₖ(x), лише з винесеним спільним множником ℓ(t):
 *    O(n) на точку замість O(n²) і обернена стійкість (Higham, 2004) — також поза вузлами;
 *  - Ньютон — схема Горнера з вузлами в порядку Лейї (кожен наступний максимізує
 *    добуток відстаней до попередніх). Для показу таблиця поділених різниць будується
 *    в природному порядку x, а для обчислень — у порядку Лейї: поліном той самий,
 *    але при зростаючому порядку вузлів похибка Горнера росте з n (на 50 точках — до 41).
 */
(function (Approx) {
  'use strict';

  /** Допустима відносна похибка в перевірці «поліном проходить через вузли». */
  const NODE_TOLERANCE = 1e-9;

  /** Число для таблиці: бере спільний форматер з plot.js, якщо він уже завантажений. */
  function fmt(v) {
    if (Approx.formatValue) return Approx.formatValue(v);
    return Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '—';
  }

  // ---------- Нормалізація ----------

  /**
   * Лінійне відображення відрізка вузлів [a, b] на [−1, 1].
   * @param {number[]} xs — вузли
   * @returns {{a:number, b:number, center:number, half:number,
   *            toT:function(number):number, toX:function(number):number}}
   */
  function createNormalizer(xs) {
    let a = Infinity;
    let b = -Infinity;
    xs.forEach(function (x) {
      if (x < a) a = x;
      if (x > b) b = x;
    });
    const center = a + (b - a) / 2; // не (a + b) / 2: сума може переповнитися
    const half = (b - a) / 2 || 1;  // один вузол — масштаб не змінюємо
    return {
      a: a,
      b: b,
      center: center,
      half: half,
      toT: function (x) { return (x - center) / half; },
      toX: function (t) { return center + half * t; }
    };
  }

  // ---------- Поліном Лагранжа ----------

  /**
   * Будує поліном Лагранжа p(x) = Σ y_k · L_k(x) у модифікованій барицентричній формі:
   *   L_k(t) = ℓ(t) · w_k / (t − t_k),  ℓ(t) = Π_j (t − t_j),  w_k = 1 / Π_{j≠k} (t_k − t_j).
   * Ваги w_k рахуються один раз (O(n²)), кожне значення p(x) — O(n).
   * У вузлі (t = t_k) повертається рівно y_k — без ділення на нуль.
   * @param {number[]} xs — вузли (усі різні)
   * @param {number[]} ys — значення у вузлах
   * @returns {function(number):number} функція p(x) з полями basis, weights, nodes, normalizer
   */
  function createLagrange(xs, ys) {
    const n = xs.length;
    const norm = createNormalizer(xs);
    const ts = xs.map(norm.toT);

    // Барицентричні ваги w_k = 1 / Π_{j≠k} (t_k − t_j)
    const weights = ts.map(function (tk, k) {
      let d = 1;
      for (let j = 0; j < n; j++) {
        if (j !== k) d *= tk - ts[j];
      }
      return 1 / d;
    });

    /** p(t) = ℓ(t) · Σ w_k·y_k / (t − t_k). */
    function evalT(t) {
      let ell = 1;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const d = t - ts[k];
        if (d === 0) return ys[k]; // точно у вузлі
        ell *= d;
        sum += weights[k] * ys[k] / d;
      }
      return ell * sum;
    }

    /** Базисний поліном L_k(t) = ℓ(t) · w_k / (t − t_k). */
    function basisT(k, t) {
      let ell = 1;
      for (let j = 0; j < n; j++) {
        const d = t - ts[j];
        if (d === 0) return j === k ? 1 : 0;
        if (j !== k) ell *= d;
      }
      return ell * weights[k];
    }

    function p(x) { return evalT(norm.toT(x)); }

    p.basis = function (k, x) { return basisT(k, norm.toT(x)); };
    p.weights = weights;
    p.nodes = { xs: xs.slice(), ys: ys.slice(), ts: ts };
    p.normalizer = norm;
    return p;
  }

  /**
   * Значення полінома Лагранжа в одній точці.
   * Для багатьох точок (графік) вигідніше один раз викликати createLagrange.
   * @param {number[]} xs
   * @param {number[]} ys
   * @param {number} x
   * @returns {number}
   */
  function lagrange(xs, ys, x) {
    return createLagrange(xs, ys)(x);
  }

  // ---------- Поліном Ньютона ----------

  /**
   * Класична таблиця поділених різниць на заданих вузлах.
   * table[k][i] = f[z_i, …, z_{i+k}]; table[0] — значення y_i.
   * @param {number[]} zs — вузли (x або нормалізовані t)
   * @param {number[]} ys
   * @returns {number[][]} трикутна таблиця: стовпець k має n − k елементів
   */
  function dividedDifferences(zs, ys) {
    const n = zs.length;
    const table = [ys.slice()];
    for (let k = 1; k < n; k++) {
      const prev = table[k - 1];
      const col = [];
      for (let i = 0; i < n - k; i++) {
        col.push((prev[i + 1] - prev[i]) / (zs[i + k] - zs[i]));
      }
      table.push(col);
    }
    return table;
  }

  /**
   * Порядок Лейї: перший — вузол з найбільшим |t|, далі щоразу той, що максимізує
   * добуток відстаней до вже вибраних (рахуємо суму логарифмів — без переповнення).
   * @param {number[]} ts
   * @returns {number[]} індекси вузлів
   */
  function lejaOrder(ts) {
    const n = ts.length;
    const order = [];
    const used = new Array(n).fill(false);
    const logProd = new Array(n).fill(0);
    let first = 0;
    for (let i = 1; i < n; i++) if (Math.abs(ts[i]) > Math.abs(ts[first])) first = i;
    let next = first;
    while (order.length < n) {
      order.push(next);
      used[next] = true;
      let best = -1, bestVal = -Infinity;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        logProd[i] += Math.log(Math.abs(ts[i] - ts[next]));
        if (logProd[i] > bestVal) { bestVal = logProd[i]; best = i; }
      }
      next = best;
    }
    return order;
  }

  /**
   * @typedef {Object} NewtonPoly
   * @property {number[]} xs, ys — вузли
   * @property {number[]} ts — нормалізовані вузли
   * @property {Object} normalizer — відображення x ↔ t
   * @property {number[][]} tableT — поділені різниці у змінній t (для обчислень)
   * @property {number[][]} tableX — ті самі різниці у змінній x (для звіту й ручної перевірки)
   * @property {number[]} coeffsT — коефіцієнти Ньютона у змінній t
   * @property {number[]} coeffsX — коефіцієнти Ньютона у змінній x
   * @property {function(number):number} evaluate — N(x)
   */

  /**
   * Будує поліном Ньютона.
   * Обчислення — у нормалізованій змінній t, а таблицю для показу
   * перераховуємо у змінну x:  f[x_i,…,x_{i+k}] = f[t_i,…,t_{i+k}] / h^k.
   * @param {number[]} xs
   * @param {number[]} ys
   * @returns {NewtonPoly}
   */
  function buildNewton(xs, ys) {
    const n = xs.length;
    const norm = createNormalizer(xs);
    const ts = xs.map(norm.toT);
    const tableT = dividedDifferences(ts, ys);
    const tableX = tableT.map(function (col, k) {
      const scale = Math.pow(norm.half, k);
      return col.map(function (v) { return v / scale; });
    });
    const coeffsT = tableT.map(function (col) { return col[0]; });

    // Для обчислень — ті самі вузли в порядку Лейї (стійкий Горнер при великих n)
    const ord = lejaOrder(ts);
    const tsEval = ord.map(function (i) { return ts[i]; });
    const coeffsEval = dividedDifferences(tsEval, ord.map(function (i) { return ys[i]; }))
      .map(function (col) { return col[0]; });

    /** N(t) = c₀ + (t − t₀)(c₁ + (t − t₁)(c₂ + …)) — схема Горнера (вузли в порядку Лейї). */
    function evaluate(x) {
      const t = norm.toT(x);
      let result = coeffsEval[n - 1];
      for (let k = n - 2; k >= 0; k--) {
        result = result * (t - tsEval[k]) + coeffsEval[k];
      }
      return result;
    }

    return {
      xs: xs.slice(),
      ys: ys.slice(),
      ts: ts,
      normalizer: norm,
      tableT: tableT,
      tableX: tableX,
      coeffsT: coeffsT,
      coeffsX: tableX.map(function (col) { return col[0]; }),
      evaluate: evaluate
    };
  }

  /**
   * Значення полінома Ньютона в точці.
   * @param {NewtonPoly} newton — результат buildNewton
   * @param {number} x
   * @returns {number}
   */
  function newtonEval(newton, x) {
    return newton.evaluate(x);
  }

  // ---------- Інтерполянт: Лагранж + Ньютон разом ----------

  /**
   * @typedef {NewtonPoly} Interpolant
   * Містить усі поля NewtonPoly (таблиці й коефіцієнти в x і t), а також:
   * @property {function(number):number} lagrange — p(x) = Σ y_k·L_k(x)
   * @property {function(number):number} newton — N(x), те саме, що evaluate
   */

  /**
   * Будує обидві форми інтерполяційного полінома на спільних нормалізованих вузлах.
   * @param {number[]} xs — вузли (усі різні)
   * @param {number[]} ys — значення у вузлах
   * @returns {Interpolant}
   */
  function createInterpolant(xs, ys) {
    const interp = buildNewton(xs, ys);
    interp.lagrange = createLagrange(xs, ys);
    interp.newton = interp.evaluate;
    return interp;
  }

  // ---------- Перевірки ----------

  /**
   * Перевіряє, що поліном проходить через усі вузли: |p(x_i) − y_i| ≤ tol·max(1, |y_i|).
   *
   * Два способи виклику:
   *  - verifyNodes(interp [, tol]) — перевіряє і Лагранжа, і Ньютона,
   *    а також їхню взаємну розбіжність;
   *  - verifyNodes(xs, ys, fn [, tol]) — перевіряє одну довільну функцію.
   * @returns {{ok:boolean, maxError:number, worstIndex:number, failed:number[],
   *            lagrange?:Object, newton?:Object, discrepancy?:number, tolerance:number}}
   */
  function verifyNodes(a, b, c, d) {
    if (!Array.isArray(a)) {
      const interp = a;
      const tolerance = b === undefined ? NODE_TOLERANCE : b;
      const resL = checkFunction(interp.xs, interp.ys, interp.lagrange, tolerance);
      const resN = checkFunction(interp.xs, interp.ys, interp.newton, tolerance);
      const failed = Array.from(new Set(resL.failed.concat(resN.failed))).sort(function (p, q) { return p - q; });
      const worst = resL.maxError >= resN.maxError ? resL : resN;
      return {
        ok: resL.ok && resN.ok,
        maxError: worst.maxError,
        worstIndex: worst.worstIndex,
        failed: failed,
        lagrange: resL,
        newton: resN,
        discrepancy: maxDiscrepancy(interp.lagrange, interp.newton, interp.xs),
        tolerance: tolerance
      };
    }
    return checkFunction(a, b, c, d === undefined ? NODE_TOLERANCE : d);
  }

  /** Перевірка однієї функції у вузлах (див. verifyNodes). */
  function checkFunction(xs, ys, fn, tol) {
    const tolerance = tol;
    let maxError = 0;
    let worstIndex = -1;
    const failed = [];
    xs.forEach(function (x, i) {
      const err = Math.abs(fn(x) - ys[i]);
      if (err > maxError || worstIndex === -1) {
        maxError = err;
        worstIndex = i;
      }
      // !(err <= …) ловить і NaN
      if (!(err <= tolerance * Math.max(1, Math.abs(ys[i])))) failed.push(i);
    });
    return { ok: failed.length === 0, maxError: maxError, worstIndex: worstIndex, failed: failed, tolerance: tolerance };
  }

  /**
   * Максимальна розбіжність |A(x) − B(x)| у вузлах і в контрольних точках між ними.
   * Лагранж і Ньютон — це один і той самий поліном, тож розбіжність має бути ~1e−12.
   * @param {function(number):number} fnA
   * @param {function(number):number} fnB
   * @param {number[]} xs — вузли
   * @param {number} [samples=5] — кількість контрольних точок між вузлами
   * @returns {number}
   */
  function maxDiscrepancy(fnA, fnB, xs, samples) {
    const count = samples === undefined ? 5 : samples;
    const norm = createNormalizer(xs);
    const checkpoints = xs.slice();
    for (let s = 1; s <= count; s++) {
      checkpoints.push(norm.a + (norm.b - norm.a) * s / (count + 1));
    }
    let maxDiff = 0;
    checkpoints.forEach(function (x) {
      const diff = Math.abs(fnA(x) - fnB(x));
      if (Number.isNaN(diff)) maxDiff = Infinity; // NaN — гірше за будь-яку розбіжність
      else if (diff > maxDiff) maxDiff = diff;
    });
    return maxDiff;
  }

  // ---------- Виведення в HTML ----------

  /**
   * Виводить трикутну таблицю поділених різниць у елемент <table>.
   * Перший рядок (коефіцієнти полінома Ньютона) отримує клас coef-row,
   * порожні клітинки нижче діагоналі — клас empty.
   * @param {HTMLTableElement} tableEl — таблиця, вміст якої буде замінено
   * @param {NewtonPoly|Interpolant} newton — результат buildNewton або createInterpolant
   * @param {{space?: 'x'|'t'}} [options] — у якій змінній показувати (за замовчуванням x)
   * @returns {HTMLTableElement}
   */
  function renderDividedTable(tableEl, newton, options) {
    const opts = options || {};
    const useT = opts.space === 't';
    const nodes = useT ? newton.ts : newton.xs;
    const table = useT ? newton.tableT : newton.tableX;
    const v = useT ? 't' : 'x';
    const n = nodes.length;

    function cell(tag, text, className) {
      const el = document.createElement(tag);
      el.textContent = text;
      if (className) el.className = className;
      return el;
    }

    tableEl.textContent = '';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.append(cell('th', 'i'), cell('th', v + 'ᵢ'), cell('th', 'f[' + v + 'ᵢ]'));
    for (let k = 1; k < n; k++) headRow.appendChild(cell('th', 'порядок ' + k));
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < n; i++) {
      const tr = document.createElement('tr');
      if (i === 0) tr.className = 'coef-row';
      tr.append(cell('td', String(i)), cell('td', fmt(nodes[i])));
      for (let k = 0; k < n; k++) {
        const exists = k < n - i;
        tr.appendChild(cell('td', exists ? fmt(table[k][i]) : '', exists ? '' : 'empty'));
      }
      tbody.appendChild(tr);
    }

    tableEl.append(thead, tbody);
    return tableEl;
  }

  /**
   * Виводить у елемент результат перевірки вузлів і параметри нормалізації.
   * Позначка ✓/✗ отримує клас check-ok або check-fail.
   * @param {HTMLElement} el — контейнер (вміст буде замінено)
   * @param {Object} check — результат verifyNodes(interp)
   * @param {Interpolant} interp
   */
  function renderNodeCheck(el, check, interp) {
    const n = interp.xs.length;
    const norm = interp.normalizer;
    el.textContent = '';

    const mark = document.createElement('span');
    if (check.ok) {
      mark.className = 'check-ok';
      mark.textContent = '✓ Лагранж і Ньютон проходять через усі ' + n + ' вузлів';
    } else {
      mark.className = 'check-fail';
      mark.textContent = '✗ Поліном не проходить через вузли № ' +
        check.failed.map(function (i) { return i + 1; }).join(', ');
    }
    el.appendChild(mark);

    el.appendChild(document.createTextNode(
      ' · max |p(xᵢ) − yᵢ| = ' + fmt(check.maxError) +
      ' · max |L − N| = ' + fmt(check.discrepancy) +
      ' · t = (x − ' + fmt(norm.center) + ') / ' + fmt(norm.half) +
      ' · коефіцієнти Ньютона — перший рядок таблиці'
    ));
  }

  // ---------- Самоперевірка ----------

  /**
   * Перевіряє всі набори варіанту: проходження через вузли і збіг Лагранжа з Ньютоном.
   * Виклик з консолі браузера: Approx.runLagrangeSelfCheck()
   * @returns {Array<Object>} рядки звіту (також виводяться через console.table)
   */
  function runLagrangeSelfCheck() {
    const report = (Approx.SET_KEYS || []).map(function (key) {
      const pts = Approx.DATASETS[key].points;
      const xs = pts.map(function (p) { return p.x; });
      const ys = pts.map(function (p) { return p.y; });
      const check = verifyNodes(createInterpolant(xs, ys));
      return {
        набір: key,
        n: xs.length,
        'вузли L': check.lagrange.ok ? 'так' : 'НІ',
        'max похибка L': check.lagrange.maxError,
        'вузли N': check.newton.ok ? 'так' : 'НІ',
        'max похибка N': check.newton.maxError,
        'max|L − N|': check.discrepancy
      };
    });
    if (console.table) console.table(report);
    return report;
  }

  Approx.NODE_TOLERANCE = NODE_TOLERANCE;
  Approx.createNormalizer = createNormalizer;
  Approx.createLagrange = createLagrange;
  Approx.lagrange = lagrange;
  Approx.dividedDifferences = dividedDifferences;
  Approx.lejaOrder = lejaOrder;
  Approx.buildNewton = buildNewton;
  Approx.newtonEval = newtonEval;
  Approx.createInterpolant = createInterpolant;
  Approx.verifyNodes = verifyNodes;
  Approx.maxDiscrepancy = maxDiscrepancy;
  Approx.renderDividedTable = renderDividedTable;
  Approx.renderNodeCheck = renderNodeCheck;
  Approx.runLagrangeSelfCheck = runLagrangeSelfCheck;
})(window.Approx = window.Approx || {});
