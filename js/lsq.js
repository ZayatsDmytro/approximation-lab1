/**
 * lsq.js — метод найменших квадратів (МНК) для полінома степеня m.
 *
 * Схема розрахунку:
 *   1) нормалізація x → t ∈ [−1, 1]:  t = (x − c) / h;
 *   2) дизайн-матриця A (n × (m+1)):  A[i][j] = tᵢ^j;
 *   3) QR-розклад A = Q·R відбиттями Хаусхолдера;
 *   4) R·c = (Qᵀy)[0..m] — зворотна підстановка, c — коефіцієнти в змінній t;
 *   5) ŷᵢ = P(xᵢ), rᵢ = yᵢ − ŷᵢ, метрики SSE, RMSE, max|r|, R²;
 *   6) коефіцієнти перераховуються у змінну x — лише для показу формули.
 *
 * Чому не нормальні рівняння AᵀA·c = Aᵀy:
 *   cond(AᵀA) = cond(A)², тож втрачається вдвічі більше значущих цифр.
 *   QR працює з самою A: відбиття Хаусхолдера ортогональні, не змінюють
 *   норм векторів і не підсилюють похибки, тому похибка розв'язку ∝ cond(A).
 *   Нормалізація додатково зменшує cond(A): степені t ∈ [−1, 1] лишаються
 *   в межах [−1, 1], а стовпці 1, t, t², … значно менше схожі один на одного,
 *   ніж 1, x, x², … при x ∈ [0, 9.5].
 */
(function (Approx) {
  'use strict';

  /** Відносний поріг виродженості для діагоналі R. */
  const RANK_TOL = 1e-12;

  // ---------- Нормалізація ----------

  /**
   * Лінійне відображення відрізка [min x, max x] на [−1, 1].
   * Свій екземпляр, щоб lsq.js не залежав від порядку підключення lagrange.js.
   * @param {number[]} xs
   * @returns {{center:number, half:number, toT:function(number):number}}
   */
  function createNormalizer(xs) {
    const a = Math.min.apply(null, xs);
    const b = Math.max.apply(null, xs);
    const center = a + (b - a) / 2; // не (a + b) / 2: сума може переповнитися
    const half = (b - a) / 2 || 1; // усі x однакові — масштаб не змінюємо
    return {
      center: center,
      half: half,
      toT: function (x) { return (x - center) / half; }
    };
  }

  // ---------- Дизайн-матриця ----------

  /**
   * Дизайн-матриця полінома степеня m: A[i][j] = zᵢ^j, j = 0..m.
   * @param {number[]} zs — абсциси (тут — нормалізовані tᵢ)
   * @param {number} m — степінь полінома
   * @returns {number[][]} матриця n × (m + 1)
   */
  function designMatrix(zs, m) {
    return zs.map(function (z) {
      const row = [];
      let power = 1;
      for (let j = 0; j <= m; j++) {
        row.push(power);
        power *= z;
      }
      return row;
    });
  }

  // ---------- QR-розклад Хаусхолдера ----------

  /**
   * QR-розклад A = Q·R відбиттями Хаусхолдера Hₖ = I − βₖ·vₖ·vₖᵀ.
   * Q явно не будується: зберігаються вектори vₖ і коефіцієнти βₖ,
   * а Qᵀ застосовується до будь-якого вектора функцією applyQT.
   * Вхідна матриця не змінюється.
   * @param {number[][]} A0 — матриця n × p, n ≥ p
   * @returns {{R:number[][], vs:number[][], betas:number[], n:number, p:number}}
   */
  function householderQR(A0) {
    const A = A0.map(function (row) { return row.slice(); });
    const n = A.length;
    const p = A[0].length;
    const vs = [];
    const betas = [];

    for (let k = 0; k < p; k++) {
      // Норма підстовпця A[k..n−1][k]
      let norm = 0;
      for (let i = k; i < n; i++) norm += A[i][k] * A[i][k];
      norm = Math.sqrt(norm);

      // v = x − α·e₁, α = −sign(x₀)·‖x‖: знак обрано так, щоб у v₀ не було
      // віднімання близьких чисел (інакше — втрата точності)
      const alpha = A[k][k] >= 0 ? -norm : norm;
      const v = [];
      for (let i = k; i < n; i++) v.push(A[i][k]);
      v[0] -= alpha;

      let vtv = 0;
      for (let i = 0; i < v.length; i++) vtv += v[i] * v[i];
      const beta = vtv > 0 ? 2 / vtv : 0; // нульовий стовпець — відбиття не потрібне
      vs.push(v);
      betas.push(beta);

      // A[k.., j] ← A[k.., j] − β·v·(vᵀ·A[k.., j]) для стовпців j = k..p−1
      for (let j = k; j < p; j++) {
        let dot = 0;
        for (let i = k; i < n; i++) dot += v[i - k] * A[i][j];
        const f = beta * dot;
        for (let i = k; i < n; i++) A[i][j] -= f * v[i - k];
      }
    }

    // R — верхній трикутник p × p; під діагоналлю записуємо точні нулі
    const R = [];
    for (let i = 0; i < p; i++) {
      const row = [];
      for (let j = 0; j < p; j++) row.push(j < i ? 0 : A[i][j]);
      R.push(row);
    }
    return { R: R, vs: vs, betas: betas, n: n, p: p };
  }

  /**
   * Обчислює Qᵀ·b, послідовно застосовуючи збережені відбиття H₀, H₁, …
   * @param {{vs:number[][], betas:number[]}} qr — результат householderQR
   * @param {number[]} b0 — вектор довжини n (не змінюється)
   * @returns {number[]}
   */
  function applyQT(qr, b0) {
    const b = b0.slice();
    for (let k = 0; k < qr.vs.length; k++) {
      const v = qr.vs[k];
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * b[k + i];
      const f = qr.betas[k] * dot;
      for (let i = 0; i < v.length; i++) b[k + i] -= f * v[i];
    }
    return b;
  }

  /**
   * Зворотна підстановка для верхньотрикутної системи R·c = d.
   * @param {number[][]} R
   * @param {number[]} d
   * @returns {number[]}
   * @throws {Error} якщо R вироджена (дизайн-матриця неповного рангу)
   */
  function backSubstitute(R, d) {
    const p = R.length;
    let maxDiag = 0;
    for (let i = 0; i < p; i++) maxDiag = Math.max(maxDiag, Math.abs(R[i][i]));

    const c = new Array(p).fill(0);
    for (let i = p - 1; i >= 0; i--) {
      if (!(Math.abs(R[i][i]) > RANK_TOL * maxDiag)) {
        throw new Error('Дизайн-матриця неповного рангу: різних x менше, ніж m + 1');
      }
      let s = d[i];
      for (let j = i + 1; j < p; j++) s -= R[i][j] * c[j];
      c[i] = s / R[i][i];
    }
    return c;
  }

  /**
   * Розв'язок задачі min ‖A·c − b‖₂ через QR.
   * Бонус QR: ‖b − A·c‖² = Σ (Qᵀb)ᵢ² для i ≥ p, тобто SSE видно ще до обчислення залишків.
   * @param {number[][]} A — n × p
   * @param {number[]} b — n
   * @returns {{coeffs:number[], R:number[][], qtb:number[], sseFromQR:number}}
   */
  function solveLeastSquaresQR(A, b) {
    const qr = householderQR(A);
    const qtb = applyQT(qr, b);
    const coeffs = backSubstitute(qr.R, qtb.slice(0, qr.p));
    let sseFromQR = 0;
    for (let i = qr.p; i < qtb.length; i++) sseFromQR += qtb[i] * qtb[i];
    return { coeffs: coeffs, R: qr.R, qtb: qtb, sseFromQR: sseFromQR };
  }

  // ---------- Поліноми ----------

  /**
   * Значення полінома c₀ + c₁z + … + cₘzᵐ за схемою Горнера.
   * @param {number[]} coeffs
   * @param {number} z
   * @returns {number}
   */
  function horner(coeffs, z) {
    let result = 0;
    for (let j = coeffs.length - 1; j >= 0; j--) result = result * z + coeffs[j];
    return result;
  }

  /**
   * Перерахунок коефіцієнтів з t у x, де t = (x − center) / half:
   *   Σ cⱼ·tʲ = Σ aₖ·xᵏ,   aₖ = Σ_{j≥k} cⱼ · C(j, k) · (−center)^{j−k} / half^j.
   * Потрібен лише для показу формули P(x); значення рахуються в t.
   * @param {number[]} cT — коефіцієнти в t
   * @param {number} center
   * @param {number} half
   * @returns {number[]} коефіцієнти в x
   */
  function coeffsTtoX(cT, center, half) {
    const p = cT.length;
    const a = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      const scaled = cT[j] / Math.pow(half, j);
      let binom = 1; // C(j, k), рахуємо від k = j до 0
      for (let k = j; k >= 0; k--) {
        a[k] += scaled * binom * Math.pow(-center, j - k);
        binom = binom * k / (j - k + 1);
      }
    }
    return a;
  }

  // ---------- МНК ----------

  /**
   * @typedef {Object} FitResult
   * @property {number} degree — степінь m
   * @property {number} n — кількість точок
   * @property {number[]} coeffs — коефіцієнти a₀…aₘ у змінній x (для формули)
   * @property {number[]} coeffsT — коефіцієнти c₀…cₘ у нормалізованій змінній t
   * @property {{center:number, half:number}} normalizer — параметри t = (x − center) / half
   * @property {function(number):number} evaluate — P(x), рахує в t (стійко)
   * @property {number[]} fitted — ŷᵢ = P(xᵢ)
   * @property {number[]} residuals — rᵢ = yᵢ − ŷᵢ
   * @property {number} SSE — сума квадратів залишків Σ rᵢ²
   * @property {number} RMSE — √(SSE / n)
   * @property {number} maxAbs — max |rᵢ|
   * @property {number} R2 — коефіцієнт детермінації 1 − SSE / SST (NaN, якщо всі y однакові)
   * @property {number} sseFromQR — SSE, отримана з хвоста Qᵀy (контроль)
   * @property {number} orthogonality — max |Aᵀr| (має бути ≈ 0: залишок ⟂ стовпцям A)
   */

  /**
   * Поліноміальна апроксимація степеня m методом найменших квадратів.
   * @param {number[]} xs
   * @param {number[]} ys
   * @param {number} m — степінь полінома (m < n)
   * @returns {FitResult}
   * @throws {Error} якщо точок замало або різних x менше, ніж m + 1
   */
  function lsqFit(xs, ys, m) {
    const n = xs.length;
    if (!(m >= 0) || m !== Math.floor(m)) throw new Error('Степінь m має бути цілим невід’ємним числом');
    if (m >= n) {
      const need = m + 1;
      const word = (need % 10 >= 2 && need % 10 <= 4 && (need % 100 < 12 || need % 100 > 14)) ? 'точки' : 'точок';
      throw new Error('Для степеня m = ' + m + ' потрібно щонайменше ' + need + ' ' + word);
    }

    const norm = createNormalizer(xs);
    const ts = xs.map(norm.toT);
    const A = designMatrix(ts, m);
    const sol = solveLeastSquaresQR(A, ys);
    const cT = sol.coeffs;

    const evaluate = function (x) { return horner(cT, norm.toT(x)); };
    const fitted = ts.map(function (t) { return horner(cT, t); });
    const residuals = ys.map(function (y, i) { return y - fitted[i]; });

    let SSE = 0;
    let maxAbs = 0;
    residuals.forEach(function (r) {
      SSE += r * r;
      if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
    });

    const yMean = ys.reduce(function (s, y) { return s + y; }, 0) / n;
    let SST = 0;
    ys.forEach(function (y) { SST += (y - yMean) * (y - yMean); });
    // Якщо y сталі (SST — лише шум округлення), R² = 1 − SSE/SST — це 0/0 і дає
    // випадкові числа (−7, −20, 1…). Тоді R² невизначений: NaN, в інтерфейсі «—».
    const yMax = ys.reduce(function (m, y) { return Math.max(m, Math.abs(y)); }, 0);
    const sstNoise = n * Math.pow(64 * Number.EPSILON * Math.max(yMax, Number.MIN_VALUE), 2);
    const R2 = SST > sstNoise ? 1 - SSE / SST : NaN;

    // Контроль: у розв'язку МНК вектор залишків ортогональний стовпцям A
    let orthogonality = 0;
    for (let j = 0; j <= m; j++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += A[i][j] * residuals[i];
      orthogonality = Math.max(orthogonality, Math.abs(dot));
    }

    const RMSE = Math.sqrt(SSE / n);
    return {
      degree: m,
      n: n,
      coeffs: coeffsTtoX(cT, norm.center, norm.half),
      coeffsT: cT,
      normalizer: { center: norm.center, half: norm.half },
      evaluate: evaluate,
      fitted: fitted,
      residuals: residuals,
      SSE: SSE,
      RMSE: RMSE,
      maxAbs: maxAbs,
      R2: R2,
      sseFromQR: sol.sseFromQR,
      orthogonality: orthogonality
    };
  }

  // ---------- Самоперевірка ----------

  /**
   * Перевіряє МНК на всіх наборах і степенях m = 1..4:
   * SSE через залишки збігається з SSE з хвоста Qᵀy, а Aᵀr ≈ 0.
   * Виклик з консолі браузера: Approx.runLsqSelfCheck()
   * @returns {Array<Object>}
   */
  function runLsqSelfCheck() {
    const report = [];
    (Approx.SET_KEYS || []).forEach(function (key) {
      const pts = Approx.DATASETS[key].points;
      const xs = pts.map(function (p) { return p.x; });
      const ys = pts.map(function (p) { return p.y; });
      for (let m = 1; m <= 4 && m < xs.length; m++) {
        const f = lsqFit(xs, ys, m);
        report.push({
          набір: key,
          m: m,
          SSE: f.SSE,
          'SSE з QR': f.sseFromQR,
          RMSE: f.RMSE,
          'max|r|': f.maxAbs,
          R2: f.R2,
          'max|Aᵀr|': f.orthogonality
        });
      }
    });
    if (console.table) console.table(report);
    return report;
  }

  Approx.designMatrix = designMatrix;
  Approx.householderQR = householderQR;
  Approx.applyQT = applyQT;
  Approx.backSubstitute = backSubstitute;
  Approx.solveLeastSquaresQR = solveLeastSquaresQR;
  Approx.horner = horner;
  Approx.coeffsTtoX = coeffsTtoX;
  Approx.lsqFit = lsqFit;
  Approx.runLsqSelfCheck = runLsqSelfCheck;
})(window.Approx = window.Approx || {});
