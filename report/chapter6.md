# M-flow 记忆存储结构报告

## 概述

本文档详细解析 M-flow 的"记忆"存储架构。M-flow 采用**三库协同**的存储策略——图数据库、向量数据库、关系型数据库各司其职，共同构成完整的记忆存储体系。

---

## 目录

- [一、存储架构总览](#一存储架构总览)
- [二、关系型数据库 — 元数据与原始数据](#二关系型数据库--元数据与原始数据)
  - [2.1 Data 表 — 原始数据记录](#21-data-表--原始数据记录)
  - [2.2 Dataset 表 — 数据集](#22-dataset-表--数据集)
  - [2.3 DatasetEntry 关联表](#23-datasetentry-关联表)
  - [2.4 GraphRelationshipLedger 表 — 图操作日志](#24-graphrelationshipleder-表--图操作日志)
- [三、图数据库 — 记忆的知识网络](#三图数据库--记忆的知识网络)
  - [3.1 节点类型（5 种核心记忆节点）](#31-节点类型5-种核心记忆节点)
  - [3.2 边类型（节点之间的连接）](#32-边类型节点之间的连接)
  - [3.3 图数据库适配层](#33-图数据库适配层)
- [四、向量数据库 — 语义索引](#四向量数据库--语义索引)
  - [4.1 索引集合命名规则](#41-索引集合命名规则)
  - [4.2 各节点的向量索引字段](#42-各节点的向量索引字段)
  - [4.3 边关系向量索引](#43-边关系向量索引)
  - [4.4 向量数据库适配层](#44-向量数据库适配层)
- [五、三种数据库的存储结构对比](#五三种数据库的存储结构对比)
- [六、完整存储示例](#六完整存储示例)
  - [6.1 关系型数据库中的记录](#61-关系型数据库中的记录)
  - [6.2 图数据库中的节点与边](#62-图数据库中的节点与边)
  - [6.3 向量数据库中的索引](#63-向量数据库中的索引)
- [七、关键设计要点总结](#七关键设计要点总结)

---

## 一、存储架构总览

M-flow 的记忆存储由三种数据库协同工作：

```
┌──────────────────────────────────────────────────────────────────┐
│                         M-flow 存储架构                          │
│                                                                  │
│  ┌─────────────────────┐    ┌─────────────────────┐             │
│  │   图数据库 (Graph)   │    │  向量数据库 (Vector)  │             │
│  │   Kùzu / Neo4j /    │    │  Chroma / LanceDB /  │             │
│  │   Neptune           │    │  Milvus / Qdrant /   │             │
│  │                     │    │  PGVector / Pinecone  │             │
│  │  存储：节点 + 边     │    │                      │             │
│  │  (记忆的网络结构)     │    │  存储：向量嵌入       │             │
│  │                     │    │  (记忆的语义索引)      │             │
│  └──────────┬──────────┘    └──────────┬───────────┘             │
│             │                          │                         │
│             └──────────┬───────────────┘                         │
│                        │                                         │
│                        ▼                                         │
│  ┌──────────────────────────────────────────────────────┐        │
│  │           关系型数据库 (Relational / SQL)              │        │
│  │           SQLite / PostgreSQL                         │        │
│  │                                                       │        │
│  │  存储：用户、数据集、Data 记录、操作日志等元数据          │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

| 数据库类型 | 存储内容 | 可选后端 |
|-----------|---------|---------|
| **图数据库** | 记忆的知识网络（节点 + 边） | Kùzu（默认）、Neo4j、Amazon Neptune |
| **向量数据库** | 文本的向量嵌入（语义索引） | ChromaDB（默认）、LanceDB、Milvus、PGVector、Pinecone、Qdrant |
| **关系型数据库** | 元数据（用户、数据集、Data 记录、操作日志） | SQLite（默认）、PostgreSQL |

---

## 二、关系型数据库 — 元数据与原始数据

关系型数据库存储所有结构化元数据，包括用户信息、数据集、原始 Data 记录、操作日志等。

### 2.1 Data 表 — 原始数据记录

每条记录代表一个经过摄入处理的原始数据项（文件或文本内容）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键，唯一标识 |
| `name` | str | 原始文件名 |
| `extension` | str | 处理后的文件扩展名 |
| `mime_type` | str | 处理后的 MIME 类型 |
| `original_extension` | str? | 原始文件扩展名 |
| `original_mime_type` | str? | 原始 MIME 类型 |
| `parser_name` | str | 用于加载数据的解析器名称 |
| `processed_path` | str | 处理后数据的存储路径 |
| `source_path` | str | 原始数据的存储路径 |
| `owner_id` | UUID | 数据所有者（用户 ID） |
| `tenant_id` | UUID? | 可选租户关联 |
| `content_hash` | str | 处理后的内容哈希值 |
| `source_digest` | str | 原始内容的哈希值 |
| `external_metadata` | dict | 用户提供的元数据 |
| `graph_scope` | dict? | 关联的图节点标签 |
| `workflow_state` | dict | 处理工作流状态 |
| `token_count` | int | 文本内容的 Token 数量 |
| `data_size` | int? | 数据大小（字节） |
| `created_at` | datetime | 创建时间戳 |

### 2.2 Dataset 表 — 数据集

数据集是用户内容的组织单元，每个数据集包含多个 Data 记录。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `name` | str | 数据集名称（如 "main_dataset"） |
| `owner_id` | UUID | 数据集所有者 |
| `tenant_id` | UUID? | 可选租户关联 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime? | 最后修改时间 |

**数据集归属规则**：由调用时传入的 `dataset_name` 决定，不做智能分类。不指定时默认归入 `"main_dataset"`。

### 2.3 DatasetEntry 关联表

多对多关联表，连接 Dataset 和 Data。

| 字段 | 类型 | 说明 |
|------|------|------|
| `dataset_id` | UUID | 数据集 ID（外键 → datasets.id） |
| `data_id` | UUID | 数据记录 ID（外键 → data.id） |
| `created_at` | datetime | 关联建立时间 |

### 2.4 GraphRelationshipLedger 表 — 图操作日志

记录所有图数据库的节点/边写入操作，用于审计和追踪。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `source_node_id` | UUID | 源节点 ID |
| `destination_node_id` | UUID | 目标节点 ID |
| `creator_function` | str | 创建者函数名（如 "KuzuAdapter.add_nodes"） |
| `node_label` | str? | 节点标签（仅节点操作） |

---

## 三、图数据库 — 记忆的知识网络

图数据库是 M-flow 的核心存储。记忆不是存成一个大文本，而是拆成**节点 (Node)** 和**边 (Edge)**，形成一张知识网络。

### 3.1 节点类型（5 种核心记忆节点）

所有节点都继承自 `MemoryNode` 基类，包含以下公共字段：

```
MemoryNode (基类)
  ├── id: UUID              ← 唯一标识
  ├── type: str             ← 节点类型名（自动填充为子类名）
  ├── version: int          ← 版本号（更新时递增）
  ├── created_at: int       ← 创建时间戳（毫秒）
  ├── updated_at: int       ← 更新时间戳（毫秒）
  ├── metadata: dict        ← 元数据（标记哪些字段需要向量索引）
  ├── schema_aligned: bool  ← 是否对齐模式
  ├── graph_depth: int?     ← 图深度
  ├── memory_spaces: list?  ← 所属记忆空间（子图隔离）
  ├── mentioned_time_start_ms: int?   ← 提及时间范围起始
  ├── mentioned_time_end_ms: int?     ← 提及时间范围结束
  ├── mentioned_time_confidence: float?  ← 时间置信度
  └── mentioned_time_text: str?       ← 时间文本描述
```

#### ① Episode（情景节点）— 记忆的"锚点"

代表一个完整的情景或事件，是记忆网络的核心入口。

```
Episode
  ├── name: str              ← 短标题
  ├── summary: str           ← 摘要（被向量索引！用于检索）
  ├── signature: str?        ← 稳定标识符
  ├── status: str?           ← 状态（open/closed）
  ├── memory_type: str?      ← "episodic" | "atomic"
  ├── has_facet: [Edge+Facet]  ← 连接到 Facet（带语义边）
  ├── involves_entity: [Edge+Entity]  ← 连接到 Entity
  ├── includes_chunk: [Edge+ContentFragment]  ← 连接到原始分块（证据追溯）
  └── derived_procedure: [Edge+Procedure]  ← 连接到 Procedure（学习操作）
```

**向量索引字段**：`["summary"]`

#### ② Facet（事实面节点）— 记忆的"细节"

描述 Episode 的某个具体方面，如决策、风险、结果、指标等。

```
Facet
  ├── name: str              ← 名称（建议 = search_text）
  ├── facet_type: str        ← 类型（decision/risk/outcome/metric/...）
  ├── search_text: str       ← 主要检索句（被向量索引！）
  ├── aliases: [str]?        ← 同义表达列表
  ├── aliases_text: str?     ← 同义表达拼接文本
  ├── description: str?      ← 详细描述（不索引，用于 RAG 扩展）
  ├── anchor_text: str?      ← 中层语义字段（被向量索引！）
  ├── supported_by: [Edge+ContentFragment]  ← 证据链接
  └── has_point: [Edge+FacetPoint]  ← 细粒度事实点
```

**向量索引字段**：`["search_text", "anchor_text"]`

#### ③ Entity（实体节点）— 记忆的"主角"

代表记忆中出现的人、地点、概念等实体。

```
Entity
  ├── name: str              ← 实体名称（被向量索引！）
  ├── is_a: EntityType?      ← 实体类型（person/place/concept/...）
  ├── description: str       ← 描述
  ├── canonical_name: str?   ← 规范化名称（用于跨 Episode 匹配）
  ├── memory_type: str?      ← "episodic" | "atomic"
  ├── same_entity_as: [Edge+Entity]  ← 连接到相同实体（跨 Episode）
  └── merge_count: int       ← 合并次数
```

**向量索引字段**：`["name", "canonical_name"]`

#### ④ FacetPoint（细粒度事实点）— 记忆的"原子"

Facet 下的更细粒度事实，是记忆的最小语义单元。

```
FacetPoint
  ├── name: str              ← 名称
  ├── search_text: str       ← 主要检索句（被向量索引！）
  ├── aliases: [str]?        ← 同义表达
  ├── aliases_text: str?     ← 同义表达拼接
  ├── description: str?      ← 详细描述
  └── supported_by: [Edge+ContentFragment]  ← 证据链接
```

**向量索引字段**：`["search_text"]`

#### ⑤ MemoryTriplet（三元组）— 记忆的"关系"

表示两个节点之间的语义关系描述。

```
MemoryTriplet
  ├── text: str              ← 关系描述文本（被向量索引！）
  ├── from_node_id: str      ← 源节点 ID
  └── to_node_id: str        ← 目标节点 ID
```

**向量索引字段**：`["text"]`

### 3.2 边类型（节点之间的连接）

边通过 `Edge` 模型携带元数据：

```
Edge
  ├── weight: float?         ← 权重
  ├── weights: dict?         ← 多维度权重
  ├── relationship_type: str? ← 关系类型名
  ├── edge_text: str?        ← 关系描述文本（被向量索引！）
  └── properties: dict?      ← 额外属性
```

**主要边类型一览**：

| 边名 | 源 → 目标 | 含义 |
|------|-----------|------|
| `has_facet` | Episode → Facet | 情景包含某个事实面 |
| `involves_entity` | Episode → Entity | 情景涉及某个实体 |
| `includes_chunk` | Episode → ContentFragment | 情景来源于某个文本块 |
| `supported_by` | Facet → ContentFragment | 事实面由某文本块支持 |
| `has_point` | Facet → FacetPoint | 事实面包含细粒度事实点 |
| `same_entity_as` | Entity → Entity | 两个实体指向同一事物 |
| `derived_procedure` | Episode → Procedure | 情景衍生出某个流程 |

### 3.3 图数据库适配层

图数据库通过统一的 `GraphProvider` 抽象接口操作，支持多种后端切换。

| 后端 | 存储方式 | 适用场景 |
|------|---------|---------|
| **Kùzu**（默认） | 嵌入式本地文件 | 单机开发、轻量部署 |
| **Neo4j** | 独立服务端 | 生产环境、需要可视化 |
| **Amazon Neptune** | 云托管服务 | 大规模云端部署 |

**核心操作接口**：

```
GraphProvider
  ├── 节点 CRUD: add_node / add_nodes / has_node / get_node / delete_node
  ├── 边 CRUD:   add_edge / add_edges / has_edge / get_edges / delete_edge
  ├── 查询:      query（原生 Cypher 查询）
  └── 维护:      is_empty / prune / get_statistics
```

---

## 四、向量数据库 — 语义索引

向量数据库存储的是**向量嵌入 (vector embeddings)**——把文本转换成一组数字（向量），用来做**语义搜索**。

### 4.1 索引集合命名规则

向量索引按 `(节点类型_字段名)` 的规则分组，每个字段一个独立的集合：

```
{ClassName}_{field_name}
```

例如：
- `Episode_summary`
- `Facet_search_text`
- `Facet_anchor_text`
- `Entity_name`
- `Entity_canonical_name`
- `FacetPoint_search_text`
- `MemoryTriplet_text`

### 4.2 各节点的向量索引字段

| 节点类型 | 索引字段 | 集合名 |
|---------|---------|--------|
| Episode | `summary` | `Episode_summary` |
| Facet | `search_text`, `anchor_text` | `Facet_search_text`, `Facet_anchor_text` |
| Entity | `name`, `canonical_name` | `Entity_name`, `Entity_canonical_name` |
| FacetPoint | `search_text` | `FacetPoint_search_text` |
| MemoryTriplet | `text` | `MemoryTriplet_text` |

### 4.3 边关系向量索引

边的 `edge_text` 字段也会被向量索引。系统会聚合所有边的标签，为每种关系类型创建 `RelationType` 节点，然后对这些节点进行向量索引。

```
边数据
  │
  ├─ 聚合关系标签（按 edge_text / relationship_name 分组）
  ├─ 创建 RelationType 节点
  │   ├── relationship_name: str    ← 关系类型名
  │   ├── number_of_edges: int      ← 该类型边的数量
  │   └── edge_text: str            ← 关系描述（被向量索引）
  └─ 写入向量数据库
```

### 4.4 向量数据库适配层

向量数据库通过统一的 `VectorProvider` 协议接口操作。

| 后端 | 存储方式 | 适用场景 |
|------|---------|---------|
| **ChromaDB**（默认） | 嵌入式/客户端 | 开发测试、轻量部署 |
| **LanceDB** | 嵌入式列式存储 | 大规模本地部署 |
| **Milvus** | 分布式服务 | 生产级大规模检索 |
| **PGVector** | PostgreSQL 插件 | 与关系型数据库共用 |
| **Pinecone** | 云托管服务 | 无服务器运维 |
| **Qdrant** | 独立服务 | 高性能检索 |

**核心操作接口**：

```
VectorProvider
  ├── 集合管理: has_collection / create_collection / delete_collection
  ├── 节点 CRUD: create_memory_nodes / retrieve / delete_memory_nodes
  ├── 搜索:      search（语义搜索）/ batch_search（批量搜索）
  ├── 嵌入:      embed_data（文本 → 向量）
  └── 维护:      prune（清理孤立数据）
```

---

## 五、三种数据库的存储结构对比

| 维度 | 关系型数据库 | 图数据库 | 向量数据库 |
|------|-------------|---------|-----------|
| **存储内容** | 元数据、原始数据记录 | 记忆的知识网络（节点+边） | 文本的向量嵌入 |
| **数据结构** | 二维表（行+列） | 属性图（节点+关系） | 向量集合（向量+元数据） |
| **查询方式** | SQL 查询 | Cypher / Gremlin 图遍历 | 语义相似度搜索 |
| **核心模型** | Data / Dataset / User | Episode / Facet / Entity / Edge | Collection（按类型_字段分组） |
| **数据关系** | 外键关联（Dataset ↔ Data） | 语义边连接（has_facet / involves_entity） | 无直接关联（通过节点 ID 关联） |
| **默认后端** | SQLite | Kùzu | ChromaDB |
| **生产后端** | PostgreSQL | Neo4j | Milvus / Qdrant |

---

## 六、完整存储示例

假设输入了：**"今天天气真好，我去公园散步了。"**

### 6.1 关系型数据库中的记录

```
Data 表:
  id:           550e8400-e29b-41d4-a716-446655440000
  name:         "今天天气真好，我去公园散步了"
  content_hash: "sha256:abc123..."
  owner_id:     seed_user_uuid
  token_count:  12
  created_at:   2025-01-01 12:00:00 UTC

Dataset 表:
  id:       550e8400-e29b-41d4-a716-446655440001
  name:     "main_dataset"
  owner_id: seed_user_uuid

DatasetEntry 表:
  dataset_id: 550e8400-e29b-41d4-a716-446655440001
  data_id:    550e8400-e29b-41d4-a716-446655440000
```

### 6.2 图数据库中的节点与边

```
┌─────────────────────────────────────────────────────┐
│                     Episode                         │
│  id:       node_001                                  │
│  name:     "天气话题"                                 │
│  summary:  "用户提到今天天气很好，去公园散步了"          │
│  type:     "Episode"                                 │
│  version:  1                                         │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │ has_facet  │            │ has_facet
        ▼            │            ▼
┌───────────────┐   │   ┌───────────────────┐
│    Facet      │   │   │     Facet         │
│  id: node_002 │   │   │  id: node_003     │
│  name: "好天气"│   │   │  name: "散步"     │
│  search_text: │   │   │  search_text:     │
│  "天气很好"    │   │   │  "去公园散步"      │
│  facet_type:  │   │   │  facet_type:      │
│  "observation"│   │   │  "activity"       │
└───────────────┘   │   └───────────────────┘
                    │ involves_entity
                    ▼
            ┌───────────────┐
            │    Entity     │
            │  id: node_004 │
            │  name: "公园" │
            │  type: "place"│
            └───────────────┘
```

### 6.3 向量数据库中的索引

```
Collection: Episode_summary
  ┌─ ID: node_001,  Vector: [0.12, 0.34, ...],  Text: "用户提到今天天气很好..."

Collection: Facet_search_text
  ├─ ID: node_002,  Vector: [0.56, 0.78, ...],  Text: "天气很好"
  └─ ID: node_003,  Vector: [0.90, 0.11, ...],  Text: "去公园散步"

Collection: Entity_name
  └─ ID: node_004,  Vector: [0.22, 0.33, ...],  Text: "公园"
```

---

## 七、关键设计要点总结

| 方面 | 说明 |
|------|------|
| **三库协同** | 图数据库存网络结构，向量数据库存语义索引，关系型数据库存元数据 |
| **节点继承体系** | 所有节点继承自 `MemoryNode`，自动填充 `type` 字段为子类名 |
| **向量索引分组** | 按 `(节点类型_字段名)` 分组，每个字段独立集合，支持细粒度检索 |
| **边携带语义** | 边通过 `edge_text` 携带关系描述，同样被向量索引 |
| **适配器模式** | 每种数据库类型都有统一抽象接口，支持多种后端无缝切换 |
| **操作审计** | 图数据库的每次写入操作都会记录到 `GraphRelationshipLedger` 表 |
| **版本控制** | 每个节点有 `version` 字段，更新时递增，支持历史追溯 |
| **时间感知** | 节点支持 `mentioned_time_*` 字段，记录记忆提及的时间信息 |


