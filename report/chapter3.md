# M-flow Pipeline 与 Stage 机制说明

## 概述

本文档独立说明 M-flow 中 Pipeline（管线）和 Stage（阶段）的通用机制，不涉及具体业务指令。这是理解 `add`、`memorize` 等所有指令如何被编排执行的基础。

---

## 目录

- [一、核心概念](#一核心概念)
  - [1.1 Pipeline（管线）](#11-pipeline管线)
  - [1.2 Stage（阶段）](#12-stage阶段)
  - [1.3 Stage 的实例化方式](#13-stage-的实例化方式)
- [二、Pipeline 的执行引擎](#二pipeline-的执行引擎)
  - [2.1 `execute_workflow()` — 管线入口](#21-execute_workflow--管线入口)
  - [2.2 执行流程](#22-执行流程)
  - [2.3 各步骤职责](#23-各步骤职责)
- [三、分批处理机制](#三分批处理机制)
  - [3.1 为什么需要分批？](#31-为什么需要分批)
  - [3.2 分批实现](#32-分批实现)
- [四、并发控制机制](#四并发控制机制)
  - [4.1 三种执行模式](#41-三种执行模式)
  - [4.2 并发数决定逻辑](#42-并发数决定逻辑)
  - [4.3 两层控制关系](#43-两层控制关系)
- [五、Stage 的执行方式](#五stage-的执行方式)
  - [5.1 `process_data_items()` — 对单个 item 执行所有 Stage](#51-process_data_items--对单个-item-执行所有-stage)
  - [5.2 Stage 链的数据流](#52-stage-链的数据流)
- [六、典型 Pipeline 示例](#六典型-pipeline-示例)
  - [6.1 `add` Pipeline（数据摄入）](#61-add-pipeline数据摄入)
  - [6.2 `memorize` Pipeline（记忆化处理）](#62-memorize-pipeline记忆化处理)
  - [6.3 自定义 Pipeline](#63-自定义-pipeline)
- [七、设计要点总结](#七设计要点总结)

---

## 一、核心概念

### 1.1 Pipeline（管线）

Pipeline 是 M-flow 中**对数据进行一系列有序处理的编排框架**，类似于一条"加工流水线"。

```
原始数据 ──→ Stage 1 ──→ Stage 2 ──→ Stage 3 ──→ 处理结果
（PDF）     （分块）     （向量化）    （存入图库）
```

每个 **Stage（阶段）** 是一个处理步骤，多个 Stage 串联成一个 Pipeline。

### 1.2 Stage（阶段）

`Stage` 是一个统一的任务包装器，可以将任何可调用对象标准化为统一的执行接口。

```python
class Stage:
    def __init__(self, fn, *defaults, config=None, **kw_defaults):
        # fn: 要包装的函数
        # *defaults: 预置的位置参数
        # **kw_defaults: 预置的关键字参数
```

**支持的函数类型**：

| 类型 | 说明 | 示例 |
|------|------|------|
| 同步函数 | 普通函数 | `def fn(item): ...` |
| 异步函数 | async 函数 | `async def fn(item): ...` |
| 生成器 | 逐个 yield 结果 | `def fn(items): yield ...` |
| 异步生成器 | 异步逐个 yield | `async def fn(items): async yield ...` |

### 1.3 Stage 的实例化方式

```python
# 方式一：无预置参数
Stage(resolve_data_directories, include_subdirectories=True)

# 方式二：预置后续参数
Stage(ingest_data, ds_name, usr, nodes, ds_id, loader_cfg, created_at_ms)
# 等价于：ingest_data(data, ds_name, usr, nodes, ds_id, loader_cfg, created_at_ms)
# 其中 data 由管线引擎在运行时传入
```

Stage 的 `*defaults` 和 `**kw_defaults` 参数会被预置到函数调用中，运行时管线引擎传入的 `data` 作为第一个参数。

---

## 二、Pipeline 的执行引擎

### 2.1 `execute_workflow()` — 管线入口

```python
async def execute_workflow(tasks, data, datasets, user, name, config):
    cfg = config or WorkflowConfig()
    resolved_user, authorised = await _prepare(tasks, datasets, user, cfg)

    for ds in authorised:
        async for info in _execute_for_dataset(ds, resolved_user, tasks, data, name, cfg):
            yield info
```

### 2.2 执行流程

```
execute_workflow()
  │
  ├─ _prepare()                     ← 准备工作
  │   ├─ ensure_valid_tasks()       ← 验证 Stage 列表是否合法
  │   ├─ prepare_backends()         ← 初始化后端（图数据库、向量数据库）
  │   └─ authorize_datasets()       ← 鉴权 + 解析数据集
  │
  └─ _execute_for_dataset()         ← 对每个数据集执行
      ├─ fetch_dataset_items()      ← 获取数据集中已有的 Data 记录
      ├─ check_cache_status()       ← 检查缓存，避免重复处理
      │
      └─ run_tasks()                ← 按序执行所有 Stage
          ├─ _init_run()            ← 注册 pipeline run 记录
          │
          └─ _process_batches()     ← ★ 分批处理数据
              ├─ 分批（默认每批 20 个）
              ├─ 并发控制
              │
              └─ 对每个 item 执行所有 Stage
```

### 2.3 各步骤职责

| 步骤 | 职责 |
|------|------|
| `ensure_valid_tasks()` | 检查 Stage 列表是否合法（非空、函数可调用等） |
| `prepare_backends()` | 初始化图数据库和向量数据库的连接 |
| `authorize_datasets()` | 按名称查找数据集，找不到就创建；检查用户写权限 |
| `fetch_dataset_items()` | 查询数据集中已有的所有 Data 记录 |
| `check_cache_status()` | 检查是否已处理过，启用缓存时跳过已完成的数据集 |
| `_init_run()` | 在数据库中创建 PipelineRun 记录，标记运行开始 |
| `_process_batches()` | 将数据分批，逐批执行所有 Stage |
| `record_run_finish()` | 更新 PipelineRun 状态为完成 |
| `_flush_remote_storage()` | 如果适配器支持，将本地数据同步到远程存储 |

---

## 三、分批处理机制

### 3.1 为什么需要分批？

```python
# 坏的设计：不分批，全量并行
coros = [process(item) for item in all_10000_items]
await asyncio.gather(*coros)
# → 同时开 10,000 个数据库连接，数据库直接崩溃

# 好的设计：分批 + 限流
for batch in chunks(items, 20):       # 每批 20 个
    coros = [process(item) for item in batch]
    await run_with_concurrency_limit(coros, 20)  # 最多 20 并发
# → 任何时候最多 20 个数据库连接，安全可控
```

### 3.2 分批实现

```python
async def _process_batches(ctx, tasks, context, incremental_loading, items_per_batch):
    items = ctx.data if isinstance(ctx.data, list) else [ctx.data]

    if incremental_loading:
        items = await resolve_data_directories(items)  # 展开目录

    total = len(items)
    limit = get_pipeline_concurrency_limit()            # 获取并发限制

    for offset in range(0, len(items), items_per_batch):  # 分批
        batch = items[offset : offset + items_per_batch]

        coros = [
            process_data_items(item, ctx.dataset, tasks, ...)
            for item in batch
        ]

        batch_results = await run_with_concurrency_limit(coros, limit)
```

| 参数 | 默认值 | 作用 |
|------|:------:|------|
| `items_per_batch` | 20 | 每批处理的数据项数量 |

**分批的目的**：
- **内存控制** — 避免一次性加载所有数据到内存
- **进度跟踪** — 每批更新一次进度，可显示 "已处理 40/10000"
- **错误隔离** — 一批失败不影响其他批次

---

## 四、并发控制机制

### 4.1 三种执行模式

```python
async def run_with_concurrency_limit(coros, concurrency_limit=None):
    limit = concurrency_limit or get_pipeline_concurrency_limit()

    if limit == 1:
        # 模式一：串行执行
        for coro in coros:
            result = await coro

    elif limit >= len(coros):
        # 模式二：全并行
        return await asyncio.gather(*coros)

    else:
        # 模式三：信号量限制并行
        semaphore = asyncio.Semaphore(limit)
        async def limited_coro(coro):
            async with semaphore:
                return await coro
        return await asyncio.gather(*[limited_coro(c) for c in coros])
```

#### 模式一：串行执行（limit = 1）

```
时间 →
item1 ──┤
item2    ──┤
item3      ──┤
```

**适用场景**：SQLite 数据库。SQLite 是文件级锁，同时写会报 `database is locked`。

#### 模式二：全并行（limit >= 数量）

```
时间 →
item1 ──────────────────┤
item2 ──────────────────┤  ← 同时开始，同时结束
item3 ──────────────────┤
```

**适用场景**：PostgreSQL + 当前批数量小于并发限制。

#### 模式三：信号量限制并行（1 < limit < 数量）

```
时间 →
item1  ──────────┤
item2  ──────────┤
...               ← 同时最多 N 个
itemN  ──────────┤
itemN+1 ──────────┤  ← 等前面有空位再开始
itemN+2 ──────────┤
```

**适用场景**：PostgreSQL，默认 limit=20。

### 4.2 并发数决定逻辑

```python
def get_pipeline_concurrency_limit():
    # 1. 环境变量覆盖
    override = os.getenv("MFLOW_PIPELINE_CONCURRENCY")
    if override and int(override) > 0:
        return int(override)

    # 2. 自动检测数据库类型
    provider = _detect_db_provider()
    if provider == "sqlite":
        return 1       # SQLite → 串行
    elif provider in ("postgres", "postgresql"):
        return 20      # PostgreSQL → 20 并发
    else:
        return 1       # 未知 → 保守串行
```

| 数据库 | 默认并发数 | 原因 |
|--------|:---------:|------|
| SQLite | 1 | 文件级锁，并发写会崩 |
| PostgreSQL | 20 | 成熟的关系型数据库，支持高并发 |
| 其他 | 1 | 保守策略 |

可通过环境变量覆盖：
```bash
export MFLOW_PIPELINE_CONCURRENCY=50  # 强制 50 并发
```

### 4.3 两层控制关系

```
总数据量：10,000 个文件
  │
  ├─ 分批：每批 20 个 → 共 500 批
  │
  └─ 每批内部：并发控制
       ├─ SQLite：20 个文件串行处理（1 个 1 个来）
       └─ PostgreSQL：20 个文件并行处理（最多 20 个同时）
```

---

## 五、Stage 的执行方式

### 5.1 `process_data_items()` — 对单个 item 执行所有 Stage

每个 item 会依次经过 Pipeline 中定义的所有 Stage：

```python
# 伪代码逻辑
async def process_data_items(item, dataset, tasks, ...):
    current_input = item

    for stage in tasks:           # 遍历所有 Stage
        result = await stage.execute(current_input)  # 执行当前 Stage
        current_input = result    # 输出作为下一个 Stage 的输入

    return current_input
```

### 5.2 Stage 链的数据流

```
item ──→ Stage 1 ──→ Stage 2 ──→ Stage 3 ──→ 最终结果
         (预处理)    (核心处理)   (后处理)
```

每个 Stage 的输出作为下一个 Stage 的输入，形成处理链。

---

## 六、典型 Pipeline 示例

### 6.1 `add` Pipeline（数据摄入）

```python
tasks = [
    Stage(resolve_data_directories, include_subdirectories=True),
    Stage(ingest_data, ds_name, usr, nodes, ds_id, loader_cfg, created_at_ms),
]
```

### 6.2 `memorize` Pipeline（记忆化处理）

```python
tasks = [
    Stage(chunk_documents),           # 分块
    Stage(generate_embeddings),       # 向量化
    Stage(extract_knowledge),         # 知识抽取
    Stage(save_to_graph_db),          # 存图库
]
```

### 6.3 自定义 Pipeline

```python
from m_flow.pipeline import Stage, execute_workflow

custom_tasks = [
    Stage(load_data),
    Stage(transform),
    Stage(analyze),
    Stage(save_results),
]

async for result in execute_workflow(
    tasks=custom_tasks,
    datasets="我的数据集",
    user=current_user,
    name="自定义管线",
):
    print(f"进度: {result}")
```

---

## 七、设计要点总结

| 方面 | 说明 |
|------|------|
| **Stage 本质** | 统一的任务包装器，将任意函数标准化为统一接口 |
| **Stage 参数预置** | 通过 `*defaults` 和 `**kw_defaults` 预置参数，运行时只需传入 data |
| **Pipeline 本质** | Stage 的有序列表，按顺序依次执行 |
| **分批处理** | 默认每批 20 个，控制内存和进度 |
| **并发控制** | 自动检测数据库类型，SQLite 串行，PostgreSQL 20 并发 |
| **可扩展性** | 任何函数都可以包装成 Stage，自由组合成 Pipeline |
