/**
 * validation.js — розбір і перевірка точок, введених користувачем.
 * Без звертань до DOM: ці функції використовують main.js (форма) і tests.html.
 */
(function (Approx) {
  'use strict';

  const MAX_POINTS = 50;      // верхня межа кількості точок в одному наборі
  const X_TOLERANCE = 1e-12;  // x однакові, якщо різняться менше за 1e-12 · max |x| набору
  const MAX_ABS = 1e100;      // більші за модулем числа не приймаємо: (x − c)/h і xⁱ переповнюються

  /** Число для повідомлень: спільний форматер з plot.js, якщо він підключений. */
  function fmt(v) {
    if (Approx.formatValue) return Approx.formatValue(v);
    return String(Number(v.toPrecision(6)));
  }

  /**
   * Перетворює рядок у число. Допускає десяткову кому і типографський мінус.
   * @param {string} raw
   * @returns {number} NaN, якщо рядок не є числом
   */
  function parseNumber(raw) {
    const s = String(raw).trim().replace(/[−–]/g, '-').replace(',', '.');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  /**
   * Розбирає текст «одна точка на рядок: x y або x;y».
   * @param {string} text
   * @returns {{rows: Array<{xRaw:string,yRaw:string}>, errors: Array<{row:number,message:string}>}}
   */
  function parsePoints(text) {
    const rows = [];
    const errors = [];
    String(text).split(/\r?\n/).forEach(function (line, i) {
      const t = line.trim();
      if (!t) return;
      const parts = t.split(/\s*;\s*|\s+/).filter(Boolean);
      if (parts.length !== 2) {
        errors.push({ row: -1, message: 'Рядок ' + (i + 1) + ' списку: потрібно два числа через пробіл або «;»' });
        return;
      }
      rows.push({ xRaw: parts[0], yRaw: parts[1] });
    });
    if (!rows.length && !errors.length) errors.push({ row: -1, message: 'Список порожній' });
    return { rows: rows, errors: errors };
  }

  /**
   * Перевіряє рядки форми: числа, різні x, від 2 до MAX_POINTS точок.
   * Повністю порожні рядки ігноруються.
   * @param {Array<{xRaw:string,yRaw:string}>} rows
   * @returns {{ok:boolean, points:Array<{x:number,y:number}>, errors:Array<{row:number,field?:string,message:?string}>}}
   *   points — відсортовані за x; errors[].row — номер рядка форми (−1 — помилка всього набору)
   */
  function validatePoints(rows) {
    const errors = [];
    const parsed = [];
    let filled = 0;

    rows.forEach(function (row, i) {
      if (String(row.xRaw).trim() === '' && String(row.yRaw).trim() === '') return;
      filled++;
      const x = parseNumber(row.xRaw);
      const y = parseNumber(row.yRaw);
      if (!Number.isFinite(x)) errors.push({ row: i, field: 'x', message: 'Точка ' + (i + 1) + ': x має бути числом' });
      else if (Math.abs(x) > MAX_ABS) errors.push({ row: i, field: 'x', message: 'Точка ' + (i + 1) + ': |x| більше за 1e100' });
      if (!Number.isFinite(y)) errors.push({ row: i, field: 'y', message: 'Точка ' + (i + 1) + ': y має бути числом' });
      else if (Math.abs(y) > MAX_ABS) errors.push({ row: i, field: 'y', message: 'Точка ' + (i + 1) + ': |y| більше за 1e100' });
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= MAX_ABS && Math.abs(y) <= MAX_ABS) {
        parsed.push({ x: x, y: y, row: i });
      }
    });

    // Однакові x роблять інтерполяцію неможливою (ділення на нуль у базисі Лагранжа)
    // Допуск відносний до масштабу x усього набору: 1e-13 і 5e-13 — різні точки,
    // а 1 і 1 + 1e-15 — однакові (інтерполяція на них вироджена)
    const sorted = parsed.slice().sort(function (a, b) { return a.x - b.x; });
    const xScale = sorted.reduce(function (m, p) { return Math.max(m, Math.abs(p.x)); }, 0);
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1], b = sorted[k];
      if (Math.abs(b.x - a.x) <= X_TOLERANCE * xScale) {
        errors.push({ row: b.row, field: 'x', message: 'Точки ' + (a.row + 1) + ' і ' + (b.row + 1) + ': однакові x = ' + fmt(b.x) });
        errors.push({ row: a.row, field: 'x', message: null }); // лише підсвітити поле
      }
    }

    if (filled < 2) errors.push({ row: -1, message: 'Потрібно щонайменше 2 точки (зараз ' + filled + ')' });
    if (filled > MAX_POINTS) errors.push({ row: -1, message: 'Забагато точок: максимум ' + MAX_POINTS });

    return {
      ok: errors.length === 0,
      points: sorted.map(function (p) { return { x: p.x, y: p.y }; }),
      errors: errors
    };
  }

  Approx.MAX_POINTS = MAX_POINTS;
  Approx.parseNumber = parseNumber;
  Approx.parsePoints = parsePoints;
  Approx.validatePoints = validatePoints;
})(window.Approx = window.Approx || {});
