> **Кик-офф промт для нового агента.** Скопировать целиком в первую сессию. Источник: подготовлен
> 2026-09-24 после аудита; опирается на `research/2026-09-24-session-handoff.md`.

---

Ты продолжаешь работу над **Margo** — форк RetainDB, память-слой для AI-агентов (decisions/constraints/goals/
procedures/corrections/preferences, два режима: local JSON и server PostgreSQL+pgvector).
Репозиторий: `C:\Users\Oblre\OneDrive\Рабочий стол\RetainDB`. Сервер сборки и тестов: `pilarovds@46.16.36.148:~/Margo`.

## 1. Прочитай в этом порядке (контекст, не навыки)

1. `research/2026-09-24-session-handoff.md` — **точка входа**. Начни с §0 (smoke test): не начинай работу,
   пока ожидания не сошлись (лог git, 11 modified + 7 untracked, наличие ADR-014, 393 теста, индекс codegraph).
2. `research/2026-09-08-adr-implementation-order.md` — **единственный источник по порядку и состоянию
   этапов**: карта состояния по 14 ADR, предусловия P1–P5, exit criteria у каждого этапа.
3. `AGENTS.md` — устройство репозитория, конфиг, тесты, workflow (синхронизация локально↔сервер).
4. `TECH_DEBT.md` — открытый долг. `architecture/ADR-014-*.md` + `ADR-013-*.md` — решения, которые исполняешь.

## 2. Навыки: источник и назначение

**Источник (локальный):** `C:\Users\Oblre\AppData\Local\hermes\skills\software-development\<name>\SKILL.md`.
Загружать **явно**: `skill_view(name="<name>")` — индекс навыков подхватывает их только со следующей сессии,
поэтому в этой сессии они доступны исключительно явным вызовом. Скрипты навыков лежат рядом, в `<name>/scripts/`.
Порт сделан из opencode-набора (`~/.config/opencode/skills/`); таблица соответствия «было → стало» —
в `disciplined-engineer/references/hermes-mapping.md`. Вспомогательные части: `assets/` (шаблоны ADR/review/
spike), `references/` (delegation, search-patterns, test-signals).

| Навык | Назначение | Когда грузить |
|---|---|---|
| `disciplined-engineer` | **оркестратор**: фазы 0–5 (контекст → размер задачи → research/ADR-гейт → утверждение → работа → shutdown), escalation «2 ошибки подряд — стоп» | в начале сессии, всегда |
| `test-discipline` | test-first + жёсткий гейт `scripts/gate.py` (`GATE: PASS` / `BLOCKED`, PASS требует доказательства, что раннер реально прогнал тесты) | перед и после каждой правки кода |
| `code-reviewer` | ревью диффа по 5 осям со severity + `scripts/review-scope.py` (scope из git, с untracked) | перед коммитом и в конце сессии |
| `architect` | ADR: falsification-критерии, blast radius, альтернативы; `scripts/next-adr.py` (нумерация, `--create`) | когда принимается архитектурное решение, а не при рутинной правке |
| `research-spike` | time-boxed разведка с рекомендацией и рисками, `references/search-patterns.md` (операторы `web_search`) | перед задачей >50 LOC или незнакомой технологией |
| `tech-debt-tracker` | леджер `TECH_DEBT.md` + `scripts/scan-debt.py` (FIXME/TODO/xfail, включая untracked) | в начале сессии (прочитать) и в конце (сверить) |
| `history-keeper` | `History.md` (append-only) + `NOTES.md` ≤60 строк (`scripts/check-notes.py`) | в начале (читать) и в конце (писать) |
| `devops` | инфраструктура: порты, контейнеры, SSH, PG; `scripts/{check-port,http-health,pg-check,docker-inspect}.py` | **только** при инфраструктурной проблеме |
| `codegraph` | индекс и запросы по коду: `mcp__codegraph__codegraph_explore` (CLI-фолбэк `codegraph explore "…"`) | для вопросов «где/как устроено» — **до** grep и чтения файлов |
| `hermes-agent-skill-authoring` | правка самих навыков (frontmatter, лимит 60 символов на description) | если правишь навык |

**Не грузить зря:** `devops`, `architect`, `research-spike` без повода — это оверхед. Тесты, порты, HTTP,
PG и docker проверяются скриптами, а не руками сгенерированными командами.

## 3. Задача сессии: покрыть Этап 2.0, затем начать Этап 2

**Шаг 0 — закрепить baseline и починить TD-002** (закрывает предусловие P1, снимает блокер коммита):
- локально: в `scripts/benchmark/gen_pool.py` дефолт `--project` → `distractor`; в `qa/latency-set.json`
  `project: "default"` → `distractor`;
- на сервере: `python3 scripts/benchmark/run.py --suite retrieval --k 10 --write-baseline` (пишет
  `qa/baseline-<дата>.json` **и** мержит в `qa/baseline.json`);
- контроль: второй прогон **без** `--write-baseline` → печатает сравнение с baseline.
- **Приёмка:** расхождение между прогонами ≤ 1 п.п. по `recall@10`; датированный файл закоммичен
  (он tracked; `qa/bench-*.json` — нет).

**Шаг 1 — per-layer tracing без изменения поведения** (ADR-014 шаг 1):
`engine/retrieval/types.ts` (`Candidate`, `LayerTrace`, `RetrievalMode`) + `engine/retrieval/trace.ts`;
`{in,out,dropped,ms,cutoff}` для S0–S3 встроить в монолиты `engine/memory/search.ts` и `engine/retriever.ts`,
**не меняя логику**. **Приёмка:** drop-off виден в телеметрии, `recall@10` не изменился ни на пункт.

**Затем Этап 2 — закрыть ADR-013 и снять вердикт ревью «Needs fixes»:**
A/B без правок кода — `WINDOW_RECALL_STRATEGY=fixed WINDOW_RECALL_MAX=30` (старое поведение) против дефолта
(`curvature`, `min=10`); плюс три правки ревью (валидация конфига окна, порядок «`rerankByScope` → затем
`selectWindow`», telemetry-счётчик выбранного `k`); затем S2/S3 окна в `retriever.ts`.
**Приёмка этапа:** `recall@10 ≥ 0.83` и `p99 ≤ +10%` против `qa/baseline-2026-09-24.json`; гейт ADR-010 — PASS;
TD-005 закрыт (`q-package-manager` ≠ 0, `q-backend` ≥ 0.67). Далее — lexical-канал S1 (Этап 2, шаг 3).

**Каждый шаг — отдельный коммит после показанного PASS.**

## 4. Правила работы (нарушение = откат работы)

- **Приёмка = показанный вывод команды**, не утверждение. «Тесты зелёные» без вывода не считается.
- **Коммит — только с явного согласия пользователя.** Пакет незакоммиченного не расширять до прогона гейта.
- **Тесты, бенчмарк и всё docker/PG-зависимое — на сервере** (локально нет Node/pnpm, демон Docker не
  запущен, `psycopg` нет). Локально доступен `python` (не `python3`) — для `py_compile` и JSON-проверок.
- **Доказательства живут на сервере, вне git** (`qa/bench-*.json`, `reviews/BENCH-*.md`) — не делать вывод
  «артефакта нет» по локальному клону.
- **Секреты — никогда в argv** (только env/`.pgpass`); **distractor-пулы (10k) не чистить**;
  **`.codegraph/` не коммитить** (и добавить в `.gitignore` до первого `git add -A`).
- **`AGENTS.md` — защищённый файл**: правки только с явного согласия пользователя.
- **Две одинаковые ошибки подряд → СТОП** и вопрос пользователю с точным трейсбеком, обеими попытками и 2–3 вариантами.
- Синхронизация: локально правишь → `scp` на сервер → на сервере `git add/commit/push` → локально
  `git fetch origin && git reset --hard origin/main`.

## 5. Definition of done сессии

1. Шаг 0 и шаг 1 закрыты с показанными выводами и зафиксированы коммитами (после согласия).
2. Этап 2: A/B окна проведён, вердикт по falsification ADR-013 назван числом, гейт прогнан.
3. `TECH_DEBT.md` обновлён (TD-002 закрыт или явно переформулирован; новые находки заведены записью).
4. План `research/2026-09-08-adr-implementation-order.md` отражает фактическое состояние этапов.
5. Отчёт: изменённые файлы, вывод гейта, номера `recall@10`/`p99` до и после, что осталось и какой шаг следующий.
6. Если сессия закончилась — обновить `research/2026-09-24-session-handoff.md` (единая точка входа для следующего агента).

## 6. Чего НЕ делать

- Не начинать Этап 5 (рефакторинг по ADR-014) — он зависит от Этапов 3–4.
- Не менять `EMBEDDING_DIM`, метрику и модели — это Этап 3 (ADR-012).
- Не править `db/vector.ts`/`cache.ts`/`oracle-select.ts` в рамках Этапа 2.
- Не выполнять отложенные решения (I1 — переформулировка критериев ADR-007/009/013; I4 — критерий улучшения
  ADR-013 в гейте; конвенция `Implementation` в шапках ADR) без отдельного согласия.
