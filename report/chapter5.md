# M-Flow `memorize` Pipeline 内部执行逻辑深度解析

> 本文档基于源码分析，详细阐述 `memorize` 命令的 8 个 Stage 的执行流程、设计思想及数据类型的逐阶段变化。
>
> 参考源码入口：`memorize.py` → `get_default_tasks()`

---

## 目录

1. [Pipeline 总览](#1-pipeline-总览)
2. [Stage 1: `detect_format` — 文档分类](#2-stage-1-detect_format--文档分类)
3. [Stage 2: `segment_documents` — 语义分块](#3-stage-2-segment_documents--语义分块)
4. [Stage 3: `route_content_v2` — 句子级内容路由](#4-stage-3-route_content_v2--句子级内容路由)
5. [Stage 4: `compress_text` — 摘要封装](#5-stage-4-compress_text--摘要封装)
6. [Stage 5: `write_episodic_memories` — 核心记忆构建](#6-stage-5-write_episodic_memories--核心记忆构建)
7. [Stage 6: `persist_memory_nodes` — 持久化存储](#7-stage-6-persist_memory_nodes--持久化存储)
8. [Stage 7: `write_same_entity_edges` — 实体关联边](#8-stage-7-write_same_entity_edges--实体关联边)
9. [Stage 8: `write_facet_entity_edges` — Facet-Entity 边](#9-stage-8-write_facet_entity_edges--facet-entity-边)
10. [数据类型变化全景图](#10-数据类型变化全景图)
11. [图结构节点与边详解](#11-图结构节点与边详解)
12. [总结](#12-总结)

---

## 1. Pipeline 总览

`memorize` 是 M-Flow 的核心记忆构建管线。它将通过 `mflow add` 注册的原始数据，经过**文档分类 → 语义分块 → 句子级路由 → 摘要封装 → 记忆构建 → 持久化 → 边后处理** 八个阶段，最终形成结构化的知识图谱记忆层。

### 1.1 两种 Pipeline 模式

根据 `get_default_tasks()` 的实现，Pipeline 有两种运行模式：

| 模式 | 条件 | Stage 顺序 |
|------|------|-----------|
| **句子级路由模式**（V2） | `sentence_routing_enabled=True` 且 `episodic_enabled=True` | detect → segment → **route_content_v2** → compress_text → write_episodic → persist → edges |
| **传统模式**（V1） | 其他情况 | detect → segment → compress_text → write_episodic → persist → edges |

V2 模式在 `compress_text` 之前插入了 `route_content_v2`，使得摘要阶段能感知句子级别的分类信息。

### 1.2 数据流核心原则

整个 Pipeline 遵循 **"线性变换 + 元数据携带"** 的设计原则：

- 每个 Stage 的输入/输出类型在接口层面保持一致（`list[X] → list[Y]`）
- 中间结果通过对象的**属性扩展**（而非类型变更）向下游传递
- 最终所有 `MemoryNode` 子类统一进入图数据库和向量索引

---

## 2. Stage 1: `detect_format` — 文档分类

### 2.1 源码位置

`classify_documents.py:93`

```python
async def detect_format(data_documents: list[Data]) -> list[Document]:
```

### 2.2 设计思想

**将数据库记录（ORM Model）转换为领域模型（Domain Model）**，是 Pipeline 的第一个适配层。

核心职责：
1. **扩展名映射**：根据 `_DOC_TYPE_MAP` 将文件扩展名映射到具体的 Document 子类
2. **元数据传递**：将 `Data.external_metadata` 序列化为 JSON 字符串，传递给 `Document.external_metadata`
3. **时间戳传播**：将 `Data.created_at`（`datetime`）转换为毫秒级时间戳，存入 `Document.created_at`，为后续时间感知处理提供锚点
4. **MemorySpace 解析**：从 `external_metadata` 中解析 `graph_scope` 字段，构建 `MemorySpace` 对象

### 2.3 数据类型变化

```
┌─────────────────────┐         ┌──────────────────────────┐
│     list[Data]      │  ──→   │     list[Document]        │
│                     │         │                          │
│  SQLAlchemy ORM     │         │  Pydantic MemoryNode     │
│  .id (UUID)         │         │  .id (UUID, 同 Data.id)  │
│  .name              │         │  .name                   │
│  .extension         │         │  .title = "name.ext"     │
│  .mime_type         │         │  .mime_type              │
│  .processed_path    │         │  .processed_path         │
│  .external_metadata │         │  .external_metadata(str) │
│  .created_at(dt)    │         │  .created_at(int ms)     │
│                     │         │  .memory_spaces          │
└─────────────────────┘         └──────────────────────────┘
```

### 2.4 关键设计决策

- **默认回退**：未知扩展名统一映射为 `TextDocument`，保证 Pipeline 不会因未知格式中断
- **类型安全**：通过 `_DOC_TYPE_MAP` 的静态字典实现 O(1) 查找，避免复杂的条件分支
- **时间锚点**：`created_at` 的毫秒级转换是为了与 LLM 输出的相对时间表达式进行统一计算（见 `_calculate_merged_time()`）

---

## 3. Stage 2: `segment_documents` — 语义分块

### 3.1 源码位置

`extract_chunks_from_documents.py:57`

```python
async def segment_documents(
    documents: list[Document],
    max_chunk_size: int,
    chunker: Chunker = TextChunker,
) -> AsyncGenerator:
```

### 3.2 设计思想

**将完整的文档切分为语义连贯的片段**，是 Pipeline 中唯一使用 `AsyncGenerator`（异步生成器）的 Stage。

核心职责：
1. **可插拔分块策略**：通过 `Chunker` 抽象类支持多种分块算法（`TextChunker`、`LangchainChunker`、`CsvChunker`）
2. **元数据传播**：将 `Document.memory_spaces` 和 `Document.created_at` 传播到每个 `ContentFragment`
3. **Token 计数**：累加每个 chunk 的 token 数，最终写回数据库的 `Data.token_count` 字段

### 3.3 数据类型变化

```
┌──────────────────────┐       ┌──────────────────────────────┐
│    list[Document]    │  ──→  │  AsyncGenerator[ContentFragment] │
│                      │       │                              │
│  Document (基类)     │       │  ContentFragment             │
│  .read() 方法        │       │  .text (str)                 │
│                      │       │  .chunk_size (int)           │
│                      │       │  .chunk_index (int)          │
│                      │       │  .cut_type (str)             │
│                      │       │  .is_part_of (Document)      │
│                      │       │  .memory_spaces              │
│                      │       │  .created_at (int ms)        │
│                      │       │  .metadata = {"text"}        │
└──────────────────────┘       └──────────────────────────────┘
```

> **注意**：虽然函数签名是 `AsyncGenerator`，但在 Pipeline 编排中，框架会将其收集为 `list[ContentFragment]` 传递给下一 Stage。

### 3.4 关键设计决策

- **惰性生成**：使用 `AsyncGenerator` 避免一次性加载所有 chunk 到内存，支持大规模文档处理
- **Document 多态**：不同的 Document 子类（`TextDocument`、`PdfDocument` 等）实现各自的 `read()` 方法，封装不同的解析逻辑
- **chunk_size 自适应**：`max_chunk_size` 默认由 LLM 上下文窗口自动计算（`get_max_chunk_tokens()`）

---

## 4. Stage 3: `route_content_v2` — 句子级内容路由

### 4.1 源码位置

`sentence_level_routing.py:85`

```python
async def route_content_v2(
    chunks: List[ContentFragment],
    content_type: ContentType = ContentType.TEXT,
) -> List[ContentFragment]:
```

### 4.2 设计思想

**在句子粒度上对内容进行分类**，这是 V2 Pipeline 的核心创新。它将一个 chunk 中的句子分为两类：

| 分类 | 含义 | 处理方式 |
|------|------|---------|
| `episodic` | 事件性/叙事性内容 | 按事件分组，每个事件创建一个 Episode |
| `atomic` | 原子性/事实性内容 | 每个句子独立创建一个 "Atomic Episode" |

核心设计原则：
1. **输入/输出类型一致**：`List[ContentFragment] → List[ContentFragment]`，保证 Pipeline 线性
2. **元数据携带**：分类结果存储在 `chunk.metadata["sentence_classifications"]`，不改变对象类型
3. **优雅降级**：任何错误（LLM 调用失败、索引越界等）都回退为全部标记为 `episodic`

### 4.3 处理流程

```
ContentFragment.text
        │
        ▼
smart_split_sentences()  ── 句子分割（支持 TEXT / DIALOG 模式）
        │
        ├── 单句 → 根据长度判断：短句→atomic，长句→episodic
        │
        └── 多句 → LLM 分类（带重试机制）
              │
              ├── 验证索引合法性
              ├── 验证覆盖完整性
              └── 失败则重试 → 仍失败则回退为全部 episodic
        │
        ▼
chunk.metadata["sentence_classifications"] = [
    SentenceClassification(sentence_idx, text, routing_type, event_id, event_topic, event_focus),
    ...
]
```

### 4.4 数据类型变化

```
┌──────────────────────────────┐       ┌──────────────────────────────────────┐
│    list[ContentFragment]     │  ──→  │      list[ContentFragment]           │
│                              │       │                                      │
│  ContentFragment             │       │  ContentFragment (不变)              │
│  .text                       │       │  .text                               │
│  .metadata = {"text"}        │       │  .metadata = {                       │
│                              │       │    "text",                           │
│                              │       │    "sentence_classifications": [     │
│                              │       │      {sentence_idx, text,            │
│                              │       │       routing_type, event_id,        │
│                              │       │       event_topic, event_focus}      │
│                              │       │    ]                                 │
│                              │       │  }                                   │
└──────────────────────────────┘       └──────────────────────────────────────┘
```

### 4.5 关键设计决策

- **LLM 分类 vs 规则分类**：多句场景使用 LLM 进行语义理解，单句场景使用启发式规则（长度阈值）避免不必要的 LLM 调用
- **原子句子的 Event ID**：每个 atomic 句子获得独立的 `atomic_event_id`，使其能像 episodic 事件一样创建 Episode 节点
- **对话自动检测**：通过 `_detect_dialog()` 正则匹配 Speaker 模式，自动切换句子分割策略

---

## 5. Stage 4: `compress_text` — 摘要封装

### 5.1 源码位置

`summarize_text.py:28`

```python
async def compress_text(
    data_chunks: list[ContentFragment],
    summarization_model: Type[BaseModel] = None,
) -> list[FragmentDigest]:
```

### 5.2 设计思想

**将 `ContentFragment` 封装为 `FragmentDigest`**，为下游的记忆构建提供统一的数据容器。

> **关键洞察**：此阶段**不执行 LLM 摘要**。摘要的实际执行在 `write_episodic_memories` 内部的 `summarize_by_event` 中完成。`compress_text` 仅做结构性的包装。

核心职责：
1. 为每个 `ContentFragment` 创建对应的 `FragmentDigest` 对象
2. 保持 `text` 字段的完整内容
3. 设置 `sections=None`（延迟到下游填充）
4. 生成确定性 ID：`uuid5(fragment.id, "FragmentDigest")`

### 5.3 数据类型变化

```
┌──────────────────────────────┐       ┌──────────────────────────────┐
│    list[ContentFragment]     │  ──→  │    list[FragmentDigest]      │
│                              │       │                              │
│  ContentFragment             │       │  FragmentDigest              │
│  .text                       │       │  .text (同 ContentFragment)  │
│  .chunk_size                 │       │  .made_from (ContentFragment)│
│  .chunk_index                │       │  .sections = None            │
│  .is_part_of                 │       │  .overall_topic = None       │
│  .metadata["sentence_..."]   │       │  .routing_type = None        │
│                              │       │  .segment_id = None          │
│                              │       │  .segment_topic = None       │
│                              │       │  .metadata = {"text"}        │
└──────────────────────────────┘       └──────────────────────────────┘
```

### 5.4 关键设计决策

- **延迟摘要**：将 LLM 摘要推迟到 `write_episodic_memories` 阶段，因为摘要需要结合 Episode 路由结果（已有 Episode 的上下文）进行
- **保留原始引用**：`made_from` 字段保留对原始 `ContentFragment` 的引用，使下游能访问 `sentence_classifications` 等元数据
- **确定性 ID**：使用 `uuid5`（基于命名空间的 UUID）确保相同 chunk 生成相同的 digest ID，支持幂等处理

---

## 6. Stage 5: `write_episodic_memories` — 核心记忆构建

### 6.1 源码位置

`write_episodic_memories.py:178`

```python
async def write_episodic_memories(
    summaries: List[FragmentDigest],
    *,
    episodic_nodeset_name: str = "Episodic",
    ...
) -> List[Any]:
```

### 6.2 设计思想

**这是整个 Pipeline 最复杂的 Stage**，负责将 `FragmentDigest` 转换为完整的知识图谱子图（Episode + Facet + Entity + 各类语义边）。

核心架构分为 5 个子阶段：

```
Phase 0A: 三路并行 ──→ 实体提取 + Facet 生成 + 语义匹配器
Phase 0C: 实体创建 ──→ 创建 Entity 节点，收集 same_entity_as 边
Step 1:   时间计算 + Facet 准备 ──→ 合并时间信息，处理 Facet 更新
Step 2:   实体描述 + FacetPoint ──→ 并行获取实体描述，提取细粒度点
Step 3-5: 节点和边创建 ──→ 构建 has_facet / involves_entity / includes_chunk 边
```

### 6.3 详细子阶段解析

#### 6.3.1 文档路由（Ingestion Routing）

在进入 5 个子阶段之前，首先执行 `_route_documents_to_episodes()`：

- **V2 模式**：按 `event_id` 分组（来自 `sentence_classifications`），每个事件组可能路由到已有 Episode 或创建新 Episode
- **V1 模式**：按 `document_id` 分组
- **路由决策**：通过向量相似度搜索 + LLM 判断，决定新内容是否应合并到已有 Episode

#### 6.3.2 Phase 0A: 三路并行

`execute_phase0a()` 并行执行三个独立任务：

1. **实体提取**（LLM）：从 chunk 内容中提取命名实体
2. **Facet 生成**（LLM）：生成 Facet（决策/风险/结果/指标等类型）
3. **语义匹配器准备**：为后续的 Facet 语义去重做准备

#### 6.3.3 Phase 0C: 实体创建

`execute_phase0c()`：

- 为每个提取的实体创建 `Entity` 节点
- 通过 `canonical_name` 查找已有实体，收集 `same_entity_as` 边
- 设置 `memory_type`（继承自 Episode 的类型）

#### 6.3.4 Step 1: 时间计算 + Facet 准备

`execute_step1()`：

- **时间合并**：解析 chunk 中的相对时间表达式，结合 `Document.created_at` 计算绝对时间戳
- **Facet 更新**：将新生成的 Facet 与已有 Facet 进行字符串去重和（可选的）语义去重
- **证据链构建**：建立 Facet → ContentFragment 的 `supported_by` 证据边

#### 6.3.5 Step 2: 实体描述 + FacetPoint

`execute_step2()`：

- **实体描述**：并行调用 LLM 为每个实体生成上下文相关的描述
- **FacetPoint**（可选）：对 Facet 进行细粒度分解，提取子要点

#### 6.3.6 Step 3-5: 节点和边创建

最终构建完整的 Episode 对象：

| 边类型 | 源 → 目标 | 语义 |
|--------|----------|------|
| `has_facet` | Episode → Facet | Episode 包含哪些 Facet |
| `involves_entity` | Episode → Entity | Episode 涉及哪些实体 |
| `includes_chunk` | Episode → ContentFragment | Episode 的证据来源 |
| `supported_by` | Facet → ContentFragment | Facet 的证据来源 |
| `same_entity_as` | Entity → Entity | 跨 Episode 的实体关联（延迟写入） |
| `involves_entity` | Facet → Entity | Facet 中提到的实体（延迟写入） |

### 6.4 数据类型变化

```
┌──────────────────────────────┐       ┌──────────────────────────────────┐
│    list[FragmentDigest]      │  ──→  │    list[MemoryNode]              │
│                              │       │                                  │
│  FragmentDigest              │       │  MemorySpace("Episodic")         │
│  .text                       │       │  Episode (多个)                  │
│  .made_from                  │       │    ├─ .name                      │
│  .sections = None            │       │    ├─ .summary (向量化字段)      │
│                              │       │    ├─ .signature                 │
│                              │       │    ├─ .has_facet → Facet[]       │
│                              │       │    ├─ .involves_entity → Entity[]│
│                              │       │    ├─ .includes_chunk → Chunk[]  │
│                              │       │    └─ .memory_type               │
│                              │       │                                  │
│                              │       │  Facet (多个)                    │
│                              │       │    ├─ .search_text (向量化字段)  │
│                              │       │    ├─ .anchor_text (向量化字段)  │
│                              │       │    ├─ .facet_type                │
│                              │       │    ├─ .aliases / .aliases_text   │
│                              │       │    └─ .supported_by → Chunk[]    │
│                              │       │                                  │
│                              │       │  Entity (多个)                   │
│                              │       │    ├─ .name (向量化字段)         │
│                              │       │    ├─ .canonical_name (向量化)   │
│                              │       │    ├─ .description               │
│                              │       │    └─ .is_a → EntityType         │
│                              │       │                                  │
│                              │       │  EntityType (多个)               │
│                              │       │  Procedure (可选, 仅 procedural) │
└──────────────────────────────┘       └──────────────────────────────────┘
```

### 6.5 关键设计决策

- **增量更新**：支持将新内容路由到已有 Episode，实现跨批次的增量记忆更新
- **延迟边写入**：`same_entity_as` 和 `facet_entity` 边不在此阶段写入，而是通过全局队列暂存，由后续 Stage 处理
- **Procedural 桥接**：当 `enable_procedural_routing=True` 时，在摘要阶段同时收集 procedural 候选，启动异步编译任务

---

## 7. Stage 6: `persist_memory_nodes` — 持久化存储

### 7.1 源码位置

`add_memory_nodes.py:220`

```python
async def persist_memory_nodes(
    memory_nodes: List[MemoryNode],
    custom_edges: Optional[List] = None,
    embed_triplets: bool = False,
) -> List[MemoryNode]:
```

### 7.2 设计思想

**将内存中的 `MemoryNode` 对象持久化到图数据库和向量索引**，是 Pipeline 的存储层。

两阶段提交策略：
1. **Phase 1 — 图结构写入**：先写入所有节点和边，确保图结构完整
2. **Phase 2 — 向量索引**：再执行向量嵌入和索引，失败不影响图结构

### 7.3 内部流程

```
memory_nodes (List[MemoryNode])
        │
        ▼
_extract_subgraphs()  ── 并行提取子图
        │                  asyncio.gather() 对每个节点调用 extract_graph()
        │                  返回 (all_nodes, all_edges)
        ▼
deduplicate_nodes_and_edges()  ── 去重
        │
        ▼
_commit_to_graph()
        ├── graph_engine.add_nodes(nodes)     ── 写入图数据库节点
        ├── graph_engine.add_edges(edges)     ── 写入图数据库边
        ├── index_memory_nodes(nodes)         ── 节点向量索引
        └── index_relations(edges)            ── 边向量索引
        │
        ▼
return memory_nodes  (透传)
```

### 7.4 数据类型变化

```
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│    list[MemoryNode]              │  ──→  │    list[MemoryNode]              │
│                                  │       │                                  │
│  (内存中的 Pydantic 对象)        │       │  (已持久化到图数据库 + 向量库)   │
│                                  │       │                                  │
│  Episode / Facet / Entity / ...  │       │  同输入（透传返回）              │
│                                  │       │                                  │
│  节点间通过 Edge 对象关联         │       │  图数据库中的节点和边已建立       │
│                                  │       │  向量索引中的嵌入已生成           │
└──────────────────────────────────┘       └──────────────────────────────────┘
```

### 7.5 关键设计决策

- **透传返回**：返回原始的 `memory_nodes` 列表（不做任何修改），使 Pipeline 链式调用不受影响
- **图优先**：先写图结构再写向量索引，确保即使向量索引失败，图查询仍可用
- **并行提取**：使用 `asyncio.gather` 并行提取所有节点的子图，充分利用 I/O 并发
- **Triplet 嵌入**（可选）：当 `embed_triplets=True` 时，额外生成 `MemoryTriplet` 嵌入，支持三元组级别的语义搜索

---

## 8. Stage 7: `write_same_entity_edges` — 实体关联边

### 8.1 源码位置

`edge_writers.py:26`

```python
async def write_same_entity_edges(memory_nodes: List[Any]) -> List[Any]:
```

### 8.2 设计思想

**连接不同 Episode 中的相同实体**，实现跨 Episode 的实体发现。

在 Stage 5 中，`write_episodic_memories` 通过 `canonical_name` 匹配发现实体关联，但**不直接写入**边，而是将边信息暂存到全局队列 `_pending_same_entity_edges`。此 Stage 从队列中取出并写入图数据库。

### 8.3 为什么需要延迟写入？

```
Stage 5 (write_episodic_memories)
  ├── 发现 Entity A 和 Entity B 的 canonical_name 相同
  ├── 将 (A→B, same_entity_as) 加入队列
  └── 返回 Episode 对象（不包含 same_entity_as 边）
        │
        ▼
Stage 6 (persist_memory_nodes)
  ├── 将 Entity A 和 Entity B 写入图数据库
  └── 此时 A 和 B 才在图数据库中真实存在
        │
        ▼
Stage 7 (write_same_entity_edges)
  ├── 从队列中取出待处理的 same_entity_as 边
  └── 写入图数据库（此时 A 和 B 已存在）
```

### 8.4 数据类型变化

```
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│    list[MemoryNode]              │  ──→  │    list[MemoryNode]              │
│                                  │       │                                  │
│  (来自 persist_memory_nodes)     │       │  同输入（透传返回）              │
│                                  │       │                                  │
│  全局队列:                        │       │  图数据库新增:                   │
│  _pending_same_entity_edges      │       │  Entity A --[same_entity_as]-->  │
│    = [{source_id, target_id,     │       │           Entity B              │
│        relationship_name,        │       │                                  │
│        edge_text}, ...]          │       │                                  │
└──────────────────────────────────┘       └──────────────────────────────────┘
```

---

## 9. Stage 8: `write_facet_entity_edges` — Facet-Entity 边

### 9.1 源码位置

`edge_writers.py:72`

```python
async def write_facet_entity_edges(memory_nodes: List[Any]) -> List[Any]:
```

### 9.2 设计思想

**连接 Facet 到其文本中提到的实体**，实现从 Facet 到实体的细粒度检索路径。

与 Stage 7 类似，Facet-Entity 边也是在 Stage 5 中通过 `_queue_facet_entity_edges()` 暂存到全局队列 `_pending_facet_entity_edges`，在此阶段统一写入。

### 9.3 匹配机制

Facet-Entity 的匹配基于**精确的实体名称匹配**（而非语义匹配）：

```
Facet.search_text = "Bitcoin price reached $60k"
Entity.name = "Bitcoin"
        │
        ▼
Facet --[involves_entity]--> Entity("Bitcoin")
```

这种设计保证了：
- **高效率**：无需额外的 LLM 调用
- **高精度**：避免语义匹配的误报
- **可追溯**：实体名称在 Facet 文本中的出现位置可精确定位

### 9.4 数据类型变化

```
┌──────────────────────────────────┐       ┌──────────────────────────────────┐
│    list[MemoryNode]              │  ──→  │    list[MemoryNode]              │
│                                  │       │                                  │
│  (来自 write_same_entity_edges)  │       │  同输入（透传返回）              │
│                                  │       │                                  │
│  全局队列:                        │       │  图数据库新增:                   │
│  _pending_facet_entity_edges     │       │  Facet --[involves_entity]-->    │
│    = [{source_id, target_id,     │       │         Entity                  │
│        relationship_name,        │       │                                  │
│        edge_text}, ...]          │       │                                  │
└──────────────────────────────────┘       └──────────────────────────────────┘
```

---

## 10. 数据类型变化全景图

### 10.1 完整数据流

```
  Stage 1: detect_format()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[Data]  ──────────────────────────────────────────────→ list[Document] │
  │ (SQLAlchemy ORM)         扩展名映射 + 元数据传递           (Pydantic Model)│
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 2: segment_documents()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[Document]  ──────────────────────────────────────────→ AsyncGenerator  │
  │ (完整文档)              Chunker 分块                       [ContentFragment]│
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 3: route_content_v2()  (仅 V2 模式)
  ┌─────────────────────────────────────────────────────────────┐
  │ list[ContentFragment]  ───────────────────────────────────→ list[ContentFragment] │
  │ (纯文本 chunk)            LLM 句子分类                     (带 sentence_classifications)│
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 4: compress_text()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[ContentFragment]  ───────────────────────────────────→ list[FragmentDigest] │
  │ (带分类元数据)             摘要封装（无 LLM）              (保留 made_from 引用)│
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 5: write_episodic_memories()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[FragmentDigest]  ───────────────────────────────────→ list[MemoryNode] │
  │ (摘要容器)                Episode + Facet + Entity 构建    (知识图谱子图)    │
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 6: persist_memory_nodes()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[MemoryNode]  ───────────────────────────────────────→ list[MemoryNode] │
  │ (内存对象)               图数据库 + 向量索引持久化         (已持久化，透传)  │
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 7: write_same_entity_edges()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[MemoryNode]  ───────────────────────────────────────→ list[MemoryNode] │
  │ (透传)                   Entity → Entity same_entity_as    (透传)           │
  └─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
  Stage 8: write_facet_entity_edges()
  ┌─────────────────────────────────────────────────────────────┐
  │ list[MemoryNode]  ───────────────────────────────────────→ list[MemoryNode] │
  │ (透传)                   Facet → Entity involves_entity    (最终输出)       │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 最终知识图谱结构

经过 8 个 Stage 的处理，Pipeline 输出一个完整的记忆子图：

```
                    ┌─────────────────────────────────────┐
                    │         MemorySpace("Episodic")      │
                    └─────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
              ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼─────┐
              │  Episode   │   │   Entity    │   │  EntityType│
              │            │   │             │   │           │
              │ .summary   │   │ .name       │   │ .name     │
              │ .signature │   │ .canonical  │   └───────────┘
              │ .memory_ty │   │ .descript.  │         │
              └─────┬──────┘   └──────┬──────┘         │is_a
                    │                 │                 │
           ┌────────┼────────┐        │                 │
           │has_facet│        │involves_entity          │
           │         │        │        │                │
     ┌─────▼────┐   │  ┌─────▼────┐   │                │
     │  Facet   │   │  │  Facet   │   │                │
     │          │   │  │          │   │                │
     │.search   │   │  │.search   │   │                │
     │.anchor   │   │  │.anchor   │   │                │
     │.facet_ty │   │  │.facet_ty │   │                │
     └─────┬────┘   │  └─────┬────┘   │                │
           │        │        │        │                │
           │supported_by      │        │                │
           │        │        │        │                │
     ┌─────▼────┐   │  ┌─────▼────┐   │                │
     │ Content  │   │  │ Content  │   │                │
     │Fragment  │   │  │Fragment  │   │                │
     │          │   │  │          │   │                │
     │.text     │   │  │.text     │   │                │
     └──────────┘   │  └──────────┘   │                │
                    │                 │                │
                    │    same_entity_as               │
                    │                 │                │
              ┌─────▼────┐   ┌───────▼───────┐        │
              │  Entity  │   │   Entity      │        │
              │(Episode1)│   │ (Episode2)    │        │
              └──────────┘   └───────────────┘        │
                                                       │
              ┌────────────────────────────────────────┘
              │
        ┌─────▼──────┐
        │  Facet     │
        │            │
        │.search_text│
        └─────┬──────┘
              │
              │ involves_entity (精确名称匹配)
              │
        ┌─────▼──────┐
        │  Entity    │
        │  "Bitcoin" │
        └────────────┘
```

---

## 11. 图结构节点与边详解

Pipeline 经过 8 个 Stage 的处理，最终输出一个结构化的知识图谱记忆层。理解图中各类节点和边的语义，是理解 M-Flow 记忆模型的关键。

### 11.1 节点类型全景

Pipeline 输出的记忆图包含以下核心节点类型：

| 节点类型 | 标签（Label） | 核心字段 | 语义 |
|---------|--------------|---------|------|
| `Episode` | `Episodic` | `.summary`（向量化）、`.signature`、`.memory_type` | 事件/叙事单元，描述"发生了什么" |
| `Facet` | `Facet` | `.search_text`（向量化）、`.anchor_text`（向量化）、`.facet_type` | 从特定维度对 Episode 的描述切面 |
| `Entity` | `Entity` | `.name`（向量化）、`.canonical_name`（向量化）、`.description` | 文本中提取的命名实体 |
| `EntityType` | `EntityType` | `.name` | 实体的类型分类标签 |
| `ContentFragment` | `ContentFragment` | `.text` | Pipeline 的原始输入片段，作为证据来源 |
| `MemorySpace` | `MemorySpace` | `.name` | 命名空间容器，隔离不同来源的记忆 |

### 11.2 各节点详解

#### 11.2.1 `Episode`（事件节点）

**语义**：一个"发生了什么"的叙事单元。可以是一个完整事件（`memory_type=episodic`），也可以是一个独立事实（`memory_type=atomic`）。

**示例**：
```
Episode: "Bitcoin price reached $60k in March 2024"
  ├── memory_type = episodic（有叙事性的事件）
  └── 包含多个 Facet 来描述不同维度
```

**关键属性**：
- `.summary`：LLM 生成的摘要文本，被向量化后用于语义搜索
- `.signature`：唯一签名，用于跨批次的去重判断
- `.memory_type`：`episodic`（事件性）或 `atomic`（原子事实）

#### 11.2.2 `Facet`（切面节点）

**语义**：从某个**维度/角度**对 Episode 的描述。一个 Episode 可以有多个 Facet，每个 Facet 关注不同的方面。

**示例**（针对同一个 Episode）：
```
Episode: "Bitcoin price reached $60k"
  ├── Facet(decision):   "Investors decided to increase BTC allocation"
  ├── Facet(risk):       "High volatility poses liquidation risk"
  ├── Facet(outcome):    "BTC hit new all-time high"
  └── Facet(metric):     "Price: $60k, Volume: $XXB"
```

**关键属性**：
- `.search_text`：用于语义搜索的文本，被向量化
- `.anchor_text`：锚定文本，被向量化，用于精确匹配场景
- `.facet_type`：切面类型，如 `decision`（决策）、`risk`（风险）、`outcome`（结果）、`metric`（指标）等
- `.aliases` / `.aliases_text`：别名列表，支持同一 Facet 的不同表述

#### 11.2.3 `Entity`（实体节点）

**语义**：文本中提取的**命名实体**——人、组织、产品、概念、加密货币等。

**示例**：
```
Entity("Bitcoin")
  ├── .canonical_name = "Bitcoin"       # 规范名称，用于跨 Episode 去重
  ├── .description = "A decentralized digital cryptocurrency..."
  └── .is_a → EntityType("Cryptocurrency")
```

**关键属性**：
- `.name`：实体名称，被向量化
- `.canonical_name`：规范名称，被向量化，用于跨 Episode 的实体匹配
- `.description`：LLM 生成的上下文相关描述
- `.is_a`：指向 `EntityType` 的引用，标识实体的类型归属

#### 11.2.4 `EntityType`（实体类型节点）

**语义**：实体的分类标签，支持类型层次化查询。

**示例**：`Person`、`Organization`、`Location`、`Cryptocurrency`、`Technology`

#### 11.2.5 `ContentFragment`（证据节点）

**语义**：Pipeline 的原始输入片段，作为所有高层节点的**证据来源**。它连接了高层抽象（Episode、Facet）和原始文本。

#### 11.2.6 `MemorySpace`（记忆空间节点）

**语义**：命名空间容器，隔离不同来源的记忆。例如 `Episodic` 空间存储事件记忆，`Procedural` 空间存储过程性知识。

### 11.3 边类型详解

Pipeline 定义了以下边类型来编码节点间的语义关系：

| 边类型 | 源 → 目标 | 语义 | 示例 |
|--------|----------|------|------|
| `has_facet` | Episode → Facet | Episode 包含哪些切面 | "BTC事件" → "价格指标" |
| `involves_entity` | Episode → Entity | Episode 涉及哪些实体 | "BTC事件" → "Bitcoin" |
| `involves_entity` | Facet → Entity | Facet 文本中提到了哪些实体 | "价格指标" → "Bitcoin" |
| `includes_chunk` | Episode → ContentFragment | Episode 的证据来源 | "BTC事件" → 原始文本片段 |
| `supported_by` | Facet → ContentFragment | Facet 的证据来源 | "价格指标" → 原始文本片段 |
| `same_entity_as` | Entity → Entity | 跨 Episode 的实体等同关系 | Entity("BTC") → Entity("Bitcoin") |
| `is_a` | Entity → EntityType | 实体的类型分类 | Entity("Bitcoin") → EntityType("Crypto") |
| `belongs_to` | Episode → MemorySpace | Episode 所属的记忆空间 | "BTC事件" → MemorySpace("Episodic") |

### 11.4 设计优势

这种节点和边的设计带来了以下核心优势：

#### 11.4.1 多粒度检索

```
用户查询: "Bitcoin 有什么风险？"
  ├── 粗粒度: 找到涉及 Bitcoin 的 Episode
  │     └── Episode → involves_entity → Entity("Bitcoin")
  ├── 中粒度: 找到 Bitcoin 相关的 Facet(risk)
  │     └── Facet(risk) → involves_entity → Entity("Bitcoin")
  └── 细粒度: 直接定位到证据文本
        └── Facet → supported_by → ContentFragment
```

从"事件级"到"切面级"到"原文级"，逐层下钻，满足不同精度的检索需求。

#### 11.4.2 跨文档关联

```
文档A: "Bitcoin reached $60k"
文档B: "BTC price surged"
  │
  ├── Entity("Bitcoin") ← same_entity_as → Entity("BTC")
  │
  └── 用户搜索 "Bitcoin" 时，两个文档的相关内容都能被召回
```

`same_entity_as` 边将不同来源、不同表述的同一实体连接起来，实现跨文档的知识融合。

#### 11.4.3 维度分离（Separation of Concerns）

```
Episode（发生了什么）
  └── Facet（从什么角度）
        └── ContentFragment（原文证据）
```

事件、切面、证据三者解耦，各自独立向量化。修改 Facet 的描述不影响 Episode 的摘要，反之亦然。

#### 11.4.4 可解释性（Evidence Chain）

```
用户看到: Facet("Bitcoin price reached $60k")
  └── 追问: "这个结论从哪来的？"
        └── supported_by → ContentFragment("...原文引用...")
```

每条知识都有**可追溯的证据链**，避免 LLM 幻觉无法溯源的问题。

#### 11.4.5 类型化查询

```
Entity("Bitcoin") → is_a → EntityType("Cryptocurrency")
Entity("Ethereum") → is_a → EntityType("Cryptocurrency")

查询: "找到所有加密货币相关的风险"
  └── EntityType("Cryptocurrency") ← is_a ← Entity
        └── involves_entity ← Facet(risk)
```

通过 `EntityType` 实现类型层次化查询，支持"找所有 X 类型的 Y"这类高级检索。

#### 11.4.6 多租户隔离

```
MemorySpace("Episodic") ← belongs_to ← Episode
MemorySpace("Procedural") ← belongs_to ← Episode
```

不同来源、不同类型的记忆在逻辑上隔离，互不干扰，同时共享 Entity 层实现跨空间的知识关联。

### 11.5 与传统 RAG 的对比

| 维度 | 传统 RAG（向量检索） | M-Flow 图结构 |
|------|-------------------|--------------|
| **存储结构** | 扁平文档块 | 多层图（事件→切面→证据） |
| **检索方式** | 单一向量相似度 | 图遍历 + 向量搜索 + 类型过滤 |
| **跨文档关联** | 无（文档块独立） | `same_entity_as` 边连接 |
| **可解释性** | 返回原文块 | 证据链可追溯 |
| **细粒度** | 文档块级别 | 事件/切面/实体多级 |
| **类型查询** | 不支持 | `EntityType` 层次化支持 |

### 11.6 与图数据库和向量数据库的关联

最终形成的**记忆图**是**逻辑概念**，而**图数据库**和**向量数据库**是它的**物理存储层**：

| 存储层 | 存储内容 | 查询能力 |
|--------|---------|---------|
| **图数据库**（如 Neo4j） | 节点（Episode/Facet/Entity）和边（has_facet/involves_entity/...） | 结构遍历、路径查询、图算法 |
| **向量数据库**（如 Qdrant） | 节点的向量嵌入（summary/search_text/name 等字段） | 语义相似度搜索、聚类 |

两阶段持久化策略（Stage 6）确保**图结构优先写入，向量索引次之**，即使向量索引失败，图查询仍可用。实际检索时两者经常配合使用——先通过向量搜索找到候选节点，再通过图遍历进行关系过滤和上下文扩展。


## 12. 总结

### 12.1 Pipeline 设计哲学

| 原则 | 体现 |
|------|------|
| **线性变换** | 每个 Stage 的输入/输出类型明确，Pipeline 编排为线性序列 |
| **元数据携带** | 中间结果通过对象属性扩展传递，而非类型变更 |
| **延迟执行** | LLM 调用推迟到最需要上下文的阶段（如摘要推迟到 Episode 路由后） |
| **优雅降级** | 任何 Stage 的失败都有回退策略（如路由失败→全部 episodic） |
| **两阶段持久化** | 图结构优先，向量索引次之，保证数据完整性 |
| **延迟边写入** | 跨节点边在节点持久化后再写入，避免引用不存在的节点 |

### 12.2 关键性能考量

1. **LLM 调用次数**：Pipeline 中主要的 LLM 调用发生在 Stage 3（句子路由）和 Stage 5（实体提取、Facet 生成、摘要），可通过 `MFLOW_CONTENT_ROUTING` 和 `MFLOW_PRECISE_MODE` 控制
2. **并发控制**：Stage 5 内部使用 `asyncio.gather` 实现三路并行，Stage 6 使用并行子图提取
3. **批处理**：通过 `chunks_per_batch` 参数控制每批处理的 chunk 数量，平衡内存和吞吐量
4. **增量更新**：Episode 路由支持跨批次的增量更新，避免重复处理已有内容

### 12.3 扩展点

| 扩展需求 | 对应位置 |
|----------|---------|
| 新增文档格式 | 实现 `Document` 子类，注册到 `_DOC_TYPE_MAP` |
| 新增分块策略 | 实现 `Chunker` 子类，通过 `--chunker` 参数选择 |
| 新增记忆类型 | 在 `write_episodic_memories` 中添加新的路由类型 |
| 新增图数据库 | 实现 `GraphProvider` 接口 |
| 新增向量数据库 | 实现 `VectorProvider` 接口 |
| 新增 LLM 提供商 | 扩展 `LLMGateway` |