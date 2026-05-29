# M-flow `add` 指令完整调用链路解析报告

## 概述

本文档详细解析 M-flow 中数据添加操作（`add`）的完整调用链路。`add` 指令的核心职责是**将原始数据摄入系统，建立 Data 记录并关联到指定数据集**，不涉及向量化、知识抽取等后续处理。

---

## 目录

- [一、三种调用方式](#一三种调用方式)
  - [1.1 CLI（命令行）](#11-cli命令行)
  - [1.2 Python API（脚本调用）](#12-python-api脚本调用)
  - [1.3 HTTP API（REST 接口）](#13-http-apirest-接口)
  - [1.4 三种方式对比](#14-三种方式对比)
  - [1.5 两个 Stage 执行概览](#15-两个-stage-执行概览)
- [二、初始化流程](#二初始化流程)
  - [2.1 `_prepare_pipeline_context()` — 准备管线上下文](#21-_prepare_pipeline_context--准备管线上下文)
- [三、两个 Stage 详解](#三两个-stage-详解)
  - [3.1 Stage 1: `resolve_data_directories()` — 目录展开](#31-stage-1-resolve_data_directories--目录展开)
  - [3.2 Stage 2: `ingest_data()` — 数据摄入（核心）](#32-stage-2-ingest_data--数据摄入核心)
- [四、完整数据流向图](#四完整数据流向图)
- [五、关键设计要点总结](#五关键设计要点总结)

---

## 一、三种调用方式

### 1.1 CLI（命令行）

```bash
mflow add "今天天气很好" -d "我的文档"
```

**调用链**：

```
CLI 终端
  │
  ▼
AddCommand.execute(args)                     ← 解析命令行参数
  │  args.data = ["今天天气很好"]
  │  args.dataset_name = "我的文档"（默认: "main_dataset"）
  │
  ▼
AddCommand._execute_add(data, dataset)       ← 异步封装
  │
  ▼
m_flow.add(data="今天天气很好", dataset_name="我的文档")  ← API 层
```

**参数定义**：

```python
parser.add_argument("data", nargs="+", ...)           # 数据内容（必填）
parser.add_argument("--dataset-name", "-d",
    default="main_dataset", ...)                       # 数据集名称（可选，默认 main_dataset）
```

### 1.2 Python API（脚本调用）

```python
import m_flow
import asyncio

async def main():
    result = await m_flow.add(
        data="今天天气很好",
        dataset_name="我的文档",
    )
asyncio.run(main())
```

**完整参数签名**：

```python
async def add(
    data: DataInput,                                    # 数据内容（文本/文件路径/二进制流/URL）
    dataset_name: str = "main_dataset",                 # 数据集名称
    user: "User" | None = None,                         # 用户（默认种子用户）
    graph_scope: list[str] | None = None,               # 图节点标签
    vector_db_config: dict | None = None,               # 向量数据库配置
    graph_db_config: dict | None = None,                # 图数据库配置
    dataset_id: UUID | None = None,                     # 数据集 UUID（覆盖 dataset_name）
    preferred_loaders: list[LoaderSpec] | None = None,  # 加载器配置
    incremental_loading: bool = True,                   # 增量加载
    enable_cache: bool = True,                          # 启用缓存
    items_per_batch: int | None = 20,                   # 每批处理数量
    created_at: int | datetime | None = None,           # 历史时间戳
) -> "RunEvent":
```

### 1.3 HTTP API（REST 接口）

```python
import httpx

response = httpx.post("http://localhost:8000/v1/add", json={
    "data": "今天天气很好",
    "dataset_name": "我的文档",
})
```

**调用链**：

```
HTTP 请求 POST /v1/add
  │
  ▼
FastAPI 路由处理
  │
  ▼
m_flow.add(data, dataset_name, ...)         ← 同一进程内调用
```

### 1.4 三种方式对比

| 方式 | 入口 | 适用场景 | 灵活性 | 自动化 |
|------|------|---------|:------:|:------:|
| **CLI** | `AddCommand.execute()` | 手动测试、快速添加 | 低 | ❌ |
| **Python API** | `m_flow.add()` | 脚本集成、自动化流程 | 高 | ✅ |
| **HTTP API** | `POST /v1/add` | 微服务、跨语言调用 | 高 | ✅ |

**核心结论**：三种方式最终都汇聚到同一个 `m_flow.add()` 函数，数据流向完全一致。CLI 是对 Python API 的一层薄封装。

### 1.5 两个 Stage 执行概览

`add` 指令由两个 Stage **顺序执行**，先展开目录，再摄入数据：

| 序号 | Stage | 职责 |
|:----:|-------|------|
| 1 | `resolve_data_directories()` | 将目录路径展开为文件列表（支持本地和 S3） |
| 2 | `ingest_data()` | 摄入数据，建立 Data 记录并关联到数据集 |

```
m_flow.add()
  │
  ├─ Stage 1: resolve_data_directories()
  │   └─ 目录 → [文件1, 文件2, ...]
  │
  └─ Stage 2: ingest_data()
      ├─ 逐项处理（保存 → 转文本 → 生成 data_id → 查重）
      └─ 统一持久化（merge + commit）
```

> Stage 的通用机制（Stage 类、Pipeline 执行引擎、分批、并发控制）详见独立文档 `m_flow_pipeline_stage_mechanism.md`。

---

## 二、初始化流程

`m_flow.add()` 内部的第一步是初始化：

```python
loader_cfg = _normalize_loader_config(preferred_loaders)  # 标准化加载器配置
created_at_ms = _normalize_created_at(created_at)         # 标准化时间戳
auth_user, auth_dataset = await _prepare_pipeline_context(
    dataset_name, dataset_id, user
)
```

### 2.1 `_prepare_pipeline_context()` — 准备管线上下文

```python
async def _prepare_pipeline_context(ds_name, ds_id, usr):
    await setup()                                          # ① 系统初始化
    auth_user, auth_dataset = await authorize_dataset(     # ② 鉴权 + 解析数据集
        dataset_name=ds_name, dataset_id=ds_id, user=usr
    )
    await reset_dataset_pipeline_run_status(               # ③ 重置管线运行状态
        auth_dataset.id, auth_user,
        pipeline_names=["add_pipeline", "memorize_pipeline"],
    )
    return auth_user, auth_dataset
```

::: details ① setup() — 系统初始化
初始化核心组件，包括 LLM 网关、数据库连接等。
:::

#### ② `authorize_dataset()` — 鉴权与数据集解析（核心）

```python
async def authorize_datasets(datasets, user=None):
    usr = user or await get_seed_user()                    # 获取用户
    ds_input = [datasets] if isinstance(datasets, (str, UUID)) else datasets
    existing = await get_authorized_existing_datasets(     # 按名称/UUID 查找
        ds_input, "write", usr
    )
    result = existing if not ds_input else await load_or_create_datasets(
        ds_input, existing, usr                            # 找不到就创建
    )
    return usr, result
```

**数据集归属决策逻辑**：

```
用户指定 dataset_name="我的文档"
  │
  ├─ "我的文档" 已存在？ → 是 → 验证写权限 → 直接使用
  │
  └─ "我的文档" 不存在？ → 自动创建新数据集
```

**关键点**：系统不做任何基于数据内容的智能分类，数据集归属完全由调用时传入的 `dataset_name` 或 `dataset_id` 决定。不指定时默认归入 `"main_dataset"`。

::: details ③ reset_dataset_pipeline_run_status() — 重置运行状态
清除该数据集之前可能遗留的运行状态，确保新管线可以正常启动。
:::

---

## 三、两个 Stage 详解

### 3.1 Stage 1: `resolve_data_directories()` — 目录展开

```python
async def resolve_data_directories(data, include_subdirectories=True):
    items = data if isinstance(data, list) else [data]

    for item in items:
        if not isinstance(item, str):
            resolved.append(item)          # 非字符串直接通过
            continue

        if parsed.scheme == "s3":
            resolved.extend(_resolve_s3_path(...))    # S3 路径展开
        elif os.path.isdir(item):
            resolved.extend(_resolve_local_dir(...))  # 本地目录展开
        else:
            resolved.append(item)          # 普通文件或文本直接通过
```

**职责**：将目录路径展开为文件列表，支持本地文件系统和 S3。非字符串（如二进制流）和普通文件直接通过。

### 3.2 Stage 2: `ingest_data()` — 数据摄入（核心）

```python
async def ingest_data(data, dataset_name, user, graph_scope=None,
                      dataset_id=None, preferred_loaders=None, created_at_ms=None):
    # ① 用户解析
    if not user:
        user = await get_seed_user()

    # ② 数据标准化
    items = data if isinstance(data, list) else [data]

    # ③ 数据集解析
    dataset = await _resolve_target_dataset(dataset_name, dataset_id, user)

    # ④ 构建已存在数据映射
    current_data = await fetch_dataset_items(dataset.id)
    existing_ids = {str(d.id) for d in current_data}

    # ⑤ 逐项处理
    for item in items:
        record, status = await _process_single_item(
            item, preferred_loaders, user, graph_scope, existing_ids, created_at_ms
        )
        # 分类记录：new / update / new_to_dataset

    # ⑥ 统一持久化
    async with db.get_async_session() as sess:
        dataset = await sess.merge(dataset)
        dataset.data.extend(new_records)
        for rec in updated_records:
            rec = await sess.merge(rec)
        dataset.data.extend(dataset_additions)
        await sess.commit()
```

#### 3.2.1 `_process_single_item()` — 单条数据处理

```
输入数据项
  │
  ├─ save_data_item_to_storage()       ← 保存原始文件
  ├─ data_item_to_text_file()          ← 转换为文本文件
  │
  ├─ ingestion.classify()              ← 分类
  ├─ ingestion.identify()              ← ★ 生成 data_id
  │     │
  │     └─ data.get_identifier() → content_hash
  │     └─ get_unique_data_id(content_hash, user)
  │          seed = f"{content_hash}{user.id}{tenant_id}"
  │          return uuid5(NAMESPACE_OID, seed)
  │
  ├─ 检查数据库中是否已存在该 data_id
  │     ├─ 存在 → 更新字段 → status = "update"
  │     └─ 不存在 → 新建 Data 对象 → status = "new"
  │
  └─ 返回 (Data | None, status)
```

#### 3.2.2 data_id 生成逻辑 — 哈希映射

```python
data_id = uuid5(NAMESPACE_OID, content_hash + user_id + tenant_id)
```

- **确定性 UUID v5**：相同内容 + 相同用户 → 相同 data_id
- **自动去重**：重复添加相同内容会自动跳过
- **用户不可控**：CLI 和 API 均不提供手动指定 data_id 的参数

#### 3.2.3 三种状态分类 — 机械性冲突解决

| 状态 | 含义 | 持久化处理 |
|------|------|-----------|
| `"new"` | 全新记录 | INSERT 到 data 表 + INSERT 到 dataset_data 关联表 |
| `"update"` | 数据库中已存在，字段已更新 | 只需 merge 到会话，建立关联 |
| `"new_to_dataset"` | 数据库中已存在但不在当前数据集 | 只需 INSERT 到 dataset_data 关联表 |

#### 3.2.4 为什么用两个数据库会话？

```
_process_single_item() 会话              ingest_data() 持久化会话
┌─────────────────────┐                 ┌──────────────────────┐
│ 开会话              │                 │ 开会话               │
│ 查询/更新 Data 记录  │                 │ sess.merge(dataset)  │
│ 提交并关闭会话       │                 │ sess.merge(records)  │
│ 返回 detached Data  │                 │ dataset.data.extend()│
└─────────────────────┘                 │ sess.commit()        │
                                        └──────────────────────┘
```

**原因**：
- `_process_single_item` 自己完成了更新操作的提交
- 外层统一会话负责建立 Dataset↔Data 的关联关系
- 确保所有关联操作在一个事务中，保证原子性

---

## 四、完整数据流向图

```
用户输入 "今天天气很好"
  │
  ├─ CLI:  mflow add "今天天气很好" -d "我的文档"
  ├─ API:  await m_flow.add("今天天气很好", dataset_name="我的文档")
  └─ HTTP: POST /v1/add {"data": "今天天气很好", "dataset_name": "我的文档"}
         │
         ▼  ─── 三种方式汇聚到同一入口 ───
         │
    m_flow.add()
      │
      ├─ 1. _prepare_pipeline_context()
      │     ├─ setup()                          ← 系统初始化
      │     ├─ authorize_dataset()              ← ★ 鉴权 + 解析/创建数据集
      │     └─ reset_dataset_pipeline_run_status()
      │
      ├─ 2. 构建两个 Stage
      │     └─ [Stage(resolve_data_directories), Stage(ingest_data, ...)]
      │
      └─ 3. 顺序执行两个 Stage
            │
            ├─ Stage 1: resolve_data_directories()
            │   └─ 展开目录（非目录则直接通过）
            │
            └─ Stage 2: ingest_data()
                ├─ _resolve_target_dataset()    ← ★ 解析数据集
                ├─ fetch_dataset_items()        ← 获取已有数据
                │
                └─ _process_single_item()       ← ★ 逐项处理（可并发）
                    ├─ save_data_item_to_storage()
                    ├─ data_item_to_text_file()
                    ├─ ingestion.classify()
                    ├─ ★ ingestion.identify()   ← data_id 哈希映射
                    ├─ ★ 查重（已存在？更新/跳过）
                    └─ 返回 Data 对象 + 状态
                │
                └─ ★ 统一持久化（merge + extend + commit）
                    ├─ new_records → INSERT data + dataset_data
                    ├─ updated_records → merge + 关联
                    └─ dataset_additions → 关联
```

---

## 五、关键设计要点总结

| 方面 | 说明 |
|------|------|
| **三种调用方式** | CLI / Python API / HTTP API，最终汇聚到 `m_flow.add()` |
| **数据集归属** | ★ 由调用时传入的 `dataset_name` 决定，不做智能分类，默认 `"main_dataset"` |
| **data_id 生成** | ★ 基于 `content_hash + user_id` 的确定性 UUID v5（哈希映射），用户不可控 |
| **去重机制** | ★ 相同内容 + 相同用户 → 相同 data_id → 自动跳过（机械性冲突解决） |
| **两个 Stage** | ★ `add` 只有 2 个 Stage：`resolve_data_directories`（目录展开）+ `ingest_data`（数据摄入），不含向量化/图入库 |
| **事务原子性** | 所有 Data↔Dataset 关联操作在同一个事务中完成 |
| **后端初始化** | `add` 阶段初始化了向量库和图数据库后端，但实际未使用 |
