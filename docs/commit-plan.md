# Commit plan (V-model)

One commit per stage. Left branch of the V — specification, design, implementation;
right branch — the matching verification step. Format: Conventional Commits.

| # | V-model stage | Commit message |
| --- | --- | --- |
| 1 | Requirements | `docs: add technical specification and acceptance criteria` |
| 2 | Architecture | `chore: scaffold project structure with plain script tags and window.Approx namespace` |
| 3 | Data | `feat(data): add variant 14 datasets (5, 8 and 20 points)` |
| 4 | Module: interpolation | `feat(interp): implement Lagrange (barycentric) and Newton with divided differences` |
| 5 | Unit tests: interpolation | `test(interp): add browser test runner; verify nodes and Newton–Lagrange agreement` |
| 6 | Module: least squares | `feat(lsq): implement polynomial least squares via Householder QR with x normalization` |
| 7 | Unit tests: least squares | `test(lsq): check degree n−1 matches interpolation, exact cubic fit and Aᵀr ≈ 0` |
| 8 | Module: input | `feat(validation): parse and validate manual point input` |
| 9 | Module: charts | `feat(plot): add canvas charts with autoscale, grid, legend, tooltips and extrapolation zones` |
| 10 | Module: residuals | `feat(plot): add residual plot with r = 0 and ±RMSE reference lines` |
| 11 | Module: animation | `feat(animation): add step-by-step demo with start, pause and reset controls` |
| 12 | Integration | `feat(ui): wire controls, dataset/compare tabs, mode switch and result tables` |
| 13 | Integration check | `style: make layout responsive, add dark theme and accessibility attributes` |
| 14 | Acceptance testing | `fix: resolve code review findings and add regression tests` |
| 15 | Documentation | `docs: add README, Mermaid diagrams and commit plan` |

## Commit bodies

```text
1  docs: add technical specification and acceptance criteria
   Functional and non-functional requirements, UI layout, constraints
   (no ES modules, no chart libraries) and the acceptance checklist.

2  chore: scaffold project structure with plain script tags and window.Approx namespace
   index.html, style.css and empty js/ modules loaded in dependency order
   so the page opens from file:// without a server.

3  feat(data): add variant 14 datasets (5, 8 and 20 points)

4  feat(interp): implement Lagrange (barycentric) and Newton with divided differences
   Evaluation in normalized t ∈ [−1, 1]; Newton uses Leja ordering for
   stable Horner evaluation; divided-difference table rendered as HTML.

5  test(interp): add browser test runner; verify nodes and Newton–Lagrange agreement
   tests.html with suite/test/expect helpers; hand-computed divided
   differences for the 5-point set.

6  feat(lsq): implement polynomial least squares via Householder QR with x normalization
   Design matrix in t, Qᵀy applied via stored reflectors, back
   substitution; SSE, RMSE, max|r|, R² and residuals.

7  test(lsq): check degree n−1 matches interpolation, exact cubic fit and Aᵀr ≈ 0

8  feat(validation): parse and validate manual point input
   Numbers with comma or typographic minus, distinct x (scale-relative
   tolerance), 2–50 points; shared by the app and the tests.

9  feat(plot): add canvas charts with autoscale, grid, legend, tooltips and extrapolation zones
   HiDPI-aware via devicePixelRatio and ResizeObserver; legend toggles
   series; 10% padding; capped extrapolation tails.

10 feat(plot): add residual plot with r = 0 and ±RMSE reference lines

11 feat(animation): add step-by-step demo with start, pause and reset controls
   Lagrange nodes added one by one with curve morphing, least-squares
   polynomial grows from y = mean, residuals appear in sequence; axes
   follow smoothly via critically damped springs.

12 feat(ui): wire controls, dataset/compare tabs, mode switch and result tables

13 style: make layout responsive, add dark theme and accessibility attributes

14 fix: resolve code review findings and add regression tests
   Fix grid loop freeze on constant data, stuck redraws under reduced
   motion, undefined R² for constant y, Newton instability at 50 points,
   formula precision for offset x; keep unsaved edits per dataset.

15 docs: add README, Mermaid diagrams and commit plan
```

## Фактична історія репозиторію

План вище запропонував AI. Код у чаті з AI змінювався від промпту до промпту, і проміжні версії файлів не збереглися.
Тому історію зібрано з остаточних файлів: кожен коміт додає модуль свого етапу V-моделі. Виправлення після
рев'ю коду (етап 14 плану) уже входять у коміти відповідних модулів, а регресійні тести — у коміт `test:`.

| # | Етап V-моделі | Коміт |
| --- | --- | --- |
| 1 | Вимоги | `docs: add technical specification and acceptance criteria` |
| 2 | Архітектура | `chore: scaffold page layout with plain script tags and window.Approx namespace` |
| 3 | Дані | `feat(data): add variant 14 datasets (5, 8 and 20 points)` |
| 4 | Модуль: інтерполяція | `feat(interp): implement Lagrange (barycentric) and Newton with divided differences` |
| 5 | Модуль: МНК | `feat(lsq): implement polynomial least squares via Householder QR with x normalization` |
| 6 | Модуль: введення | `feat(validation): parse and validate manual point input` |
| 7 | Модульні тести | `test: add browser test runner for interpolation, least squares and validation` |
| 8 | Модуль: графіки | `feat(plot): add canvas charts with autoscale, legend, tooltips and residual plot` |
| 9 | Модуль: анімація | `feat(animation): add step-by-step demo with start, pause and reset controls` |
| 10 | Інтеграція | `feat(ui): wire controls, dataset/compare tabs, mode switch and result tables` |
| 11 | Проєктування (документи) | `docs: add flowcharts, sequence and component diagrams` |
| 12 | Документація | `docs: add README, commit plan and screenshots` |
| 13 | Звіт | `docs: add lab report and AI interaction log` |
