# M_flow架构解析

## "三相"的推理机制
### Architecture

| Term            | Definition                                                     | Example                                     |
| --------------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Three-phase** | Extract → Memorize → Load: the end-to-end pipeline in M-Flow   | Data moves through all three stages         |
| **Extract**     | Ingestion: parse, normalize, and chunk raw inputs              | PDF parsing, text chunking                  |
| **Memorize**    | Graph construction: extract entities, relations, and hierarchy | NER, triplet extraction, episodic structure |
| **Load**        | Retrieval: hybrid search and ranking over graph and vectors    | Semantic recall, graph traversal            |
摄取 + 记忆 + 提取
三相路径
## 四个层级的记忆粒度

| Node           | Granularity | Description                             | Example label                        |
| -------------- | ----------- | --------------------------------------- | ------------------------------------ |
| **Episode**    | Coarse      | One coherent event or document          | “Q1 strategy review”                 |
| **Facet**      | Medium      | One theme or section within the episode | “Technical decisions”                |
| **FacetPoint** | Fine        | One concrete, retrievable point         | “We chose Neo4j for the graph layer” |
| **Entity**     | —           | Names and concepts tied to the episode  | People, products, orgs               |

并非简单的记忆平铺展开，而是形成了类似人的记忆推理机制的四层级图网络。可以达到“见微知著”的效果。
## 数据集属性
| Field  领域/范围  | Type  类型/种类 | Description  描述            |
| ------------- | ----------- | -------------------------- |
| `id`          | UUID        | Primary key                |
| `name`        | string      | Unique human-readable name |
| `description` | string      | Optional description       |
| `created_at`  | timestamp   | Creation time              |
| `owner_id`    | UUID        | Owning user (multi-tenant) |

为隐私接入，还有数据集划分提供了条件。

## 高度定制化的搜索需求
搜索可以通过下面几个维度进行定制。

| Parameter      | Type       | Description                                    | Default            |
| -------------- | ---------- | ---------------------------------------------- | ------------------ |
| `query_text`   | string     | The search query                               | Required           |
| `query_type`   | RecallMode | Recall mode                                    | TRIPLET_COMPLETION |
| `datasets`     | list[str]  | Datasets to search                             | All datasets       |
| `top_k`        | int        | Number of results to return                    | 10                 |
| `collections`  | list[str]  | Restrict vector search to specific collections | All collections    |
| `only_context` | bool       | Return context only (skip LLM answer)          | False              |

使用示例：
```python
import m_flow

results = await m_flow.search(
    query_text="technology selection criteria",
    query_type=m_flow.RecallMode.EPISODIC,
    datasets=["meeting_notes"],
    top_k=5,
    only_context=True
)
```
## 五种RecallMode展示
### EPISODIC

Best for: events, meetings, document contents.

### PROCEDURAL

> **Experimental** — Procedural retrieval is currently in testing. Please understand the parsing and usage patterns thoroughly before deploying to production. Improper use may affect ingestion data quality, model response time, and output quality.

Best for: step-by-step instructions, installation guides.

### TRIPLET_COMPLETION

Best for: entity relationships, questions requiring an LLM-generated answer.

### CHUNKS_LEXICAL

Best for: exact keyword matching.

### CYPHER

Best for: complex graph traversals.
