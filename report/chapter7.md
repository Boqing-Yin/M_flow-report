# M-flow 搜索流程报告

## 概述

本文档详细解析 M-flow 搜索系统的完整调用链路。与 `add` / `memorize` 的 Pipeline 机制不同，搜索系统采用**分层调度架构**，不经过 Stage/Pipeline 执行引擎，而是直接路由到对应的检索器进行查询。

---

## 目录

- [一、搜索架构概览](#一搜索架构概览)
- [二、搜索与 add/memorize 的核心差异](#二搜索与-addmemorize-的核心差异)
- [三、入口层：三种调用方式](#三入口层三种调用方式)
  - [3.1 CLI 命令行](#31-cli-命令行)
  - [3.2 Python API](#32-python-api)
  - [3.3 HTTP API](#33-http-api)
- [四、核心调度层：搜索路由](#四核心调度层搜索路由)
  - [4.1 主搜索函数](#41-主搜索函数)
  - [4.2 模式路由](#42-模式路由)
  - [4.3 单数据集搜索](#43-单数据集搜索)
- [五、五大搜索模式详解](#五五大搜索模式详解)
  - [5.1 TRIPLET_COMPLETION —— 三元组 + LLM 问答](#51-triplet_completion--三元组--llm-问答)
  - [5.2 EPISODIC —— 情景记忆检索](#52-episodic--情景记忆检索)
  - [5.3 PROCEDURAL —— 流程记忆检索](#53-procedural--流程记忆检索)
  - [5.4 CYPHER —— 直接图查询](#54-cypher--直接图查询)
  - [5.5 CHUNKS_LEXICAL —— 词法匹配检索](#55-chunks_lexical--词法匹配检索)
- [六、多数据集搜索](#六多数据集搜索)
- [七、会话缓存机制](#七会话缓存机制)
- [八、搜索流程时序图](#八搜索流程时序图)

---

## 一、搜索架构概览

搜索系统采用**分层架构**，从上到下依次为：

```
用户输入 (CLI / API / SDK)
        │
        ▼
┌─────────────────────────────────────┐
│        入口层 (Entry Points)         │
│  CLI: search_command.py             │
│  API: api/v1/search/search.py       │
│  SDK: m_flow.search()               │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      核心调度层 (Core Dispatch)      │
│  search/methods/search.py           │
│    ├─ search() — 主入口              │
│    ├─ _authorized_search_impl()     │
│    └─ no_access_control_search()    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      模式路由层 (Mode Routing)       │
│  get_recall_mode_tools()            │
│    └─ 根据 RecallMode 返回对应工具   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      检索器层 (Retrievers)           │
│  ┌──────────┬──────────┬─────────┐  │
│  │Triplet   │Episodic  │Procedural│  │
│  │Search    │Retriever │Retriever │  │
│  ├──────────┼──────────┼─────────┤  │
│  │Cypher    │Jaccard   │Community│  │
│  │Retriever │Retriever │Retriever│  │
│  └──────────┴──────────┴─────────┘  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      存储层 (Storage)                │
│  向量数据库 (Vector DB)              │
│  图数据库 (Graph DB)                 │
│  关系数据库 (Relational DB)          │
└─────────────────────────────────────┘
```

---

## 二、搜索与 add/memorize 的核心差异

搜索系统的执行逻辑与 `add` / `memorize` 的 Pipeline 机制有本质区别：

| 维度 | add / memorize（Pipeline） | search（分层调度） |
|------|---------------------------|-------------------|
| **执行引擎** | Stage / Pipeline 引擎，顺序执行多个 Stage | 无 Pipeline，直接函数调用 |
| **处理模式** | 批处理（分批 + 并发控制） | 单次查询 + 检索 |
| **数据流向** | 数据摄入 → 处理 → 持久化 | 查询 → 检索 → 组装 → 返回 |
| **LLM 调用** | 用于摘要、抽取、分类 | 用于基于上下文的答案生成 |
| **并发策略** | Stage 内并发 + 分批限流 | 多数据集并发搜索（asyncio.gather） |
| **状态管理** | PipelineRun 状态追踪 | 无状态，每次独立查询 |
| **输出** | 持久化到数据库 | 返回 SearchResult 对象 |

**核心区别总结**：

- `add` / `memorize` 是**数据写入管线**：数据经过多个 Stage 逐步处理，最终写入三种数据库
- `search` 是**数据读取流程**：接收查询文本，直接路由到对应的检索器，从数据库中读取数据并组装结果

---

## 三、入口层：三种调用方式

### 3.1 CLI 命令行

```bash
mflow search "查询内容" --query-type TRIPLET_COMPLETION
```

**调用链**：

```
终端输入: mflow search "查询内容" --query-type TRIPLET_COMPLETION
        │
        ▼
SearchCommand.execute()              ← 解析命令行参数
        │
        ▼
SearchCommand._run_search()          ← 解析 RecallMode 枚举
        │  调用 m_flow.search()
        ▼
m_flow.search()                      ← 进入 API 层
```

**关键参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `query_text` | 搜索查询文本 | 必填 |
| `--query-type` / `-t` | 搜索模式 | `TRIPLET_COMPLETION` |
| `--datasets` / `-d` | 限定数据集 | 全部 |
| `--top-k` / `-k` | 返回结果数 | 10 |
| `--system-prompt` | 自定义提示词文件 | `direct_answer.txt` |
| `--output-format` / `-f` | 输出格式 (pretty/json/simple) | `pretty` |

### 3.2 Python API

```python
import m_flow
import asyncio

async def main():
    result = await m_flow.search(
        query_text="今天天气怎么样",
        query_type=RecallMode.EPISODIC,
        datasets=["我的文档"],
        top_k=10,
    )
asyncio.run(main())
```

**完整参数签名**：

```python
async def search(
    query_text: str,                                    # 查询文本（必填）
    query_type: RecallMode = RecallMode.TRIPLET_COMPLETION,  # 搜索模式
    datasets: list[str] | None = None,                  # 限定数据集
    top_k: int = 10,                                    # 返回结果数
    user: User | None = None,                           # 用户
    system_prompt: str | None = None,                   # 自定义提示词
    output_format: str = "pretty",                      # 输出格式
    save_interaction: bool = False,                     # 是否保存问答对
    use_combined_context: bool = False,                 # 合并上下文模式
    verbose: bool = False,                              # 详细输出
    session_id: str | None = None,                      # 会话 ID（缓存）
    ...
) -> SearchResult:
```

### 3.3 HTTP API

```python
import httpx

response = httpx.post("http://localhost:8000/v1/search", json={
    "query_text": "今天天气怎么样",
    "mode": "episodic",
    "datasets": ["我的文档"],
    "top_k": 10,
})
```

**调用链**：

```
HTTP 请求 POST /v1/search
        │
        ▼
FastAPI 路由处理 (search.py)
        │
        ▼
execute_search()                     ← 即 m_flow.search()
```

**简化查询接口**（`query()` 函数）支持通过 `mode` 参数映射到 RecallMode：

| mode 参数 | 对应 RecallMode |
|-----------|----------------|
| `"episodic"` | `EPISODIC` |
| `"triplet"` | `TRIPLET_COMPLETION` |
| `"chunks"` | `CHUNKS_LEXICAL` |
| `"procedural"` | `PROCEDURAL` |
| `"cypher"` | `CYPHER` |

### 三种方式对比

| 方式 | 入口 | 适用场景 | 灵活性 |
|------|------|---------|:------:|
| **CLI** | `SearchCommand.execute()` | 手动测试、快速搜索 | 低 |
| **Python API** | `m_flow.search()` | 脚本集成、自动化流程 | 高 |
| **HTTP API** | `POST /v1/search` | 微服务、跨语言调用 | 高 |

**核心结论**：三种方式最终都汇聚到同一个 `m_flow.search()` 函数，数据流向完全一致。

---

## 四、核心调度层：搜索路由

### 4.1 主搜索函数

`search()` 函数是搜索系统的**核心入口**，负责：

1. **记录查询日志**
2. **发送遥测事件**
3. **路由到两种实现**：
   - 启用访问控制 → `_authorized_search_impl()`
   - 未启用访问控制 → `no_access_control_search()`
4. **持久化搜索结果**
5. **格式化输出**

```
search()
  │
  ├─ 启用访问控制?
  │   ├─ 是 → _authorized_search_impl()
  │   │         ├─ 验证用户数据集权限
  │   │         ├─ 多数据集搜索 → _execute_multi_dataset_search()
  │   │         │       └─ 并发执行 _search_single_dataset()
  │   │         │               └─ get_recall_mode_tools() → 检索器
  │   │         └─ 合并上下文模式 → 合并后调用 LLM 生成答案
  │   │
  │   └─ 否 → no_access_control_search()
  │               └─ get_recall_mode_tools() → 检索器
  │
  └─ 格式化结果
      ├─ _format_combined_result()  ← 合并模式
      └─ _format_standard_results() ← 标准模式
```

**无访问控制搜索**（`no_access_control_search()`）是简化版搜索，不检查数据集权限，流程如下：

1. 调用 `get_recall_mode_tools()` 获取检索器工具
2. 检查图数据库是否为空
3. 执行检索：`context_fn(query)` → `completion_fn(query, context)`

### 4.2 模式路由

`get_recall_mode_tools()` 是**模式路由的核心函数**，根据 `RecallMode` 创建对应的检索器实例，并返回 `[completion_fn, context_fn]` 两个工具函数。

```python
search_tasks = {
    RecallMode.TRIPLET_COMPLETION: [UnifiedTripletSearch.get_completion,
                                    UnifiedTripletSearch.get_context],
    RecallMode.CYPHER:             [CypherSearchRetriever.get_completion,
                                    CypherSearchRetriever.get_context],
    RecallMode.CHUNKS_LEXICAL:     [JaccardChunksRetriever.get_completion,
                                    JaccardChunksRetriever.get_context],
    RecallMode.EPISODIC:           [EpisodicRetriever.get_completion,
                                    EpisodicRetriever.get_context],
    RecallMode.PROCEDURAL:         [ProceduralRetriever.get_completion,
                                    ProceduralRetriever.get_context],
}
```

每个检索器都遵循**统一接口**：

| 方法 | 说明 |
|------|------|
| `get_context(query)` | 检索相关上下文（返回 `List[Edge]` 或 `str`） |
| `get_completion(query, context)` | 基于上下文生成 LLM 答案 |

### 4.3 单数据集搜索

`_search_single_dataset()` 是每个数据集的搜索流程：

1. 设置数据库上下文
2. 检查图是否为空
3. 获取 RecallMode 工具
4. 执行搜索：
   - `only_context=True` → 只调用 `context_fn()` 返回上下文
   - `only_context=False` → 先 `context_fn()` 获取上下文，再 `completion_fn()` 生成答案

---

## 五、五大搜索模式详解

### 5.1 TRIPLET_COMPLETION —— 三元组 + LLM 问答

> **用途**：自然语言问答，利用图上下文 + LLM 推理生成答案
> **适用场景**：复杂问题分析、总结、洞察

#### 检索器

`UnifiedTripletSearch` 类继承自 `BaseGraphRetriever`。

#### 核心算法

`fine_grained_triplet_search()` 函数执行以下步骤：

```
fine_grained_triplet_search()
  │
  ├─ 1. 解析查询中的时间表达式
  │    如果检测到时间，从查询中剥离时间文本
  │
  ├─ 2. 向量搜索
  │    ├─ 对查询文本进行 Embedding
  │    ├─ 并发搜索多个向量集合:
  │    │   ├─ Episode_summary        ← 事件摘要
  │    │   ├─ Entity_name            ← 实体名称
  │    │   ├─ Concept_name           ← 概念名称
  │    │   └─ RelationType_relationship_name ← 关系文本
  │    └─ 支持 memory_type_filter 过滤
  │
  ├─ 3. 图投影
  │    ├─ 获取记忆片段 (MemoryFragment)
  │    ├─ 将向量距离映射到图节点
  │    └─ 将向量距离映射到图边
  │
  ├─ 4. 计算三元组重要性
  │    └─ calculate_top_triplet_importances()
  │
  ├─ 5. 时间增强重排序
  │    ├─ 对每个边计算时间匹配度
  │    ├─ 应用时间奖励 (bonus)
  │    └─ 重新排序并截取 top_k
  │
  └─ 6. 返回排序后的 Edge 列表
```

#### LLM 答案生成

在 `UnifiedTripletSearch.get_completion()` 中：

```
get_completion()
  │
  ├─ 1. 获取三元组上下文 (get_context → get_triplets)
  │
  ├─ 2. 转换为文本 (convert_retrieved_objects_to_context)
  │    ├─ 使用 triplet_output_assembler 去重 Episode 摘要
  │    └─ 回退方案: resolve_edges_to_text()
  │
  ├─ 3. 生成 LLM 答案 (generate_completion)
  │    ├─ 使用 system_prompt (direct_answer.txt)
  │    ├─ 使用 user_prompt (graph_retrieval_context.txt)
  │    └─ 可选: 传入对话历史 (会话缓存)
  │
  └─ 4. 可选: 保存问答对到图数据库 (save_qa)
```

---

### 5.2 EPISODIC —— 情景记忆检索

> **用途**：基于事件的记忆检索，使用 Episode/Facet/Entity 图结构
> **适用场景**：事件回忆、上下文记忆检索

#### 检索器

`EpisodicRetriever` 类继承自 `BaseGraphRetriever`。

#### 核心算法

`episodic_bundle_search()` 函数执行 **11 步** 检索流程：

```
episodic_bundle_search()
  │
  ├─ 1. 查询预处理
  │    ├─ 解析时间表达式 (如 "昨天"、"上周一")
  │    ├─ 判断是否启用混合搜索 (向量 + 关键词)
  │    └─ 提取关键词
  │
  ├─ 2. 向量搜索
  │    ├─ 时间增强: 如果检测到时间，扩大候选池
  │    └─ 并发搜索多个集合
  │
  ├─ 3. 自适应评分
  │    ├─ 计算集合统计信息
  │    └─ 动态调整评分权重
  │
  ├─ 4. 精确匹配奖励
  │    ├─ 数字匹配奖励
  │    ├─ 英文术语匹配奖励
  │    └─ 关键词匹配奖励
  │
  ├─ 5. 两阶段图投影
  │    ├─ Phase 1: 从向量命中节点出发，1-hop 展开
  │    └─ Phase 2: 2-hop 展开 (Facet → FacetPoint)
  │
  ├─ 6. 写入节点距离
  │
  ├─ 7. 边距离映射
  │
  ├─ 8. 构建关系索引
  │    ├─ episode_ids, facet_ids, point_ids, entity_ids
  │    └─ 建立 Episode → Facet → FacetPoint 层级
  │
  ├─ 9. Bundle 评分
  │    ├─ 路径成本计算 (hop_cost + edge_miss_cost)
  │    ├─ FacetPoint 两跳闭合
  │    └─ 路径成本传播
  │
  ├─ 10. 时间奖励
  │     ├─ 对每个 bundle 计算时间匹配度
  │     └─ 时间越接近，奖励越高
  │
  ├─ 11. 排序与组装
  │     ├─ heapq.nsmallest 取 top_k
  │     └─ assemble_output_edges() 组装输出
  │
  └─ 返回排序后的 Edge 列表
```

#### 显示模式

`EpisodicRetriever` 支持三种显示模式（通过 `config.display_mode` 控制）：

| 模式 | 说明 |
|------|------|
| `summary` | 仅返回 Episode 摘要（简洁） |
| `detail` | 返回完整 Facet + Entity 文本（丰富） |
| `highly_related_summary` | 返回经过筛选的摘要（高相关） |

---

### 5.3 PROCEDURAL —— 流程记忆检索

> **用途**：方法类问题检索，返回 Procedure-Context-Steps 三元组
> **适用场景**：如何做、步骤流程、配置指南

#### 检索器

`ProceduralRetriever` 类继承自 `BaseGraphRetriever`。

#### 核心算法

`procedural_bundle_search()` 函数执行以下步骤：

```
procedural_bundle_search()
  │
  ├─ 1. 查询预处理
  │    ├─ 剥离疑问词 ("是什么"、"怎么做"、"how to")
  │    └─ 判断是否启用混合搜索
  │
  ├─ 2. 向量搜索 (并发搜索 4 个集合)
  │    ├─ Procedure_summary              ← 流程摘要
  │    ├─ ProcedureStepPoint_search_text  ← 步骤点
  │    ├─ ProcedureContextPoint_search_text ← 上下文点
  │    └─ RelationType_relationship_name  ← 关系文本
  │
  ├─ 3. 精确匹配奖励
  │    ├─ 数字匹配奖励
  │    └─ 英文术语匹配奖励
  │
  ├─ 4. 两阶段图投影
  │    ├─ Phase 1: Procedure → 1-hop 展开
  │    └─ Phase 2: 获取步骤点和上下文点
  │
  ├─ 5. Bundle 评分 (1-hop 评分)
  │    ├─ point_direct + edge_cost + hop
  │    └─ 路径成本计算
  │
  ├─ 6. 时间奖励 (可选)
  │
  └─ 7. 排序并返回 top_k
```

#### 流程意图检测

`has_procedural_intent()` 函数检测查询是否具有流程意图，支持中英文：

- 中文强信号：`步骤`、`流程`、`配置`、`部署`、`安装`、`修复`
- 英文信号：`how to`、`steps`、`procedure`、`troubleshoot`

#### 结构化输出

`_build_structured_context()` 方法将检索到的三元组转换为结构化 JSON：

```json
{
  "__procedural_structured__": true,
  "procedures": [
    {
      "id": "...",
      "title": "流程名称",
      "summary": "流程摘要",
      "steps": ["步骤1", "步骤2", ...],
      "context_points": [
        {"type": "context", "text": "上下文信息"}
      ]
    }
  ]
}
```

---

### 5.4 CYPHER —— 直接图查询

> **用途**：直接执行 Cypher 查询语句
> **适用场景**：高级用户、精确图遍历

#### 检索器

`CypherSearchRetriever` 类继承自 `BaseRetriever`。

#### 执行流程

```
CypherSearchRetriever.get_context()
  │
  ├─ 1. 检查图是否为空
  │
  ├─ 2. 执行原始 Cypher 查询
  │    └─ engine.query(query)
  │
  └─ 3. 返回 JSON 可序列化结果
       └─ jsonable_encoder(raw_result)
```

> ⚠️ **安全限制**：可通过环境变量 `ALLOW_CYPHER_QUERY=false` 禁用 Cypher 查询。

---

### 5.5 CHUNKS_LEXICAL —— 词法匹配检索

> **用途**：基于 Jaccard 相似度的词法匹配
> **适用场景**：精确术语匹配、停用词感知查找

#### 检索器

`JaccardChunksRetriever` 类继承自 `LexicalRetriever`。

#### 核心算法

```
JaccardChunksRetriever
  │
  ├─ _tokenize()
  │    ├─ 正则提取单词 (\w+)
  │    ├─ 转小写
  │    └─ 过滤停用词
  │
  └─ _score()
       ├─ 集合 Jaccard: |A ∩ B| / |A ∪ B|
       └─ 多重集 Jaccard: sum(min) / sum(max)
```

---

## 六、多数据集搜索

### 6.1 并发搜索

`_execute_multi_dataset_search()` 函数使用 `asyncio.gather()` 并发搜索多个数据集：

```python
coroutines = [
    _search_single_dataset(dataset=ds, ...)
    for ds in datasets
]
return await asyncio.gather(*coroutines)
```

### 6.2 合并上下文模式

当 `use_combined_context=True` 时：

1. 对每个数据集执行 `only_context=True` 的搜索
2. 合并所有数据集的上下文
3. 使用合并后的上下文调用 LLM 生成单一答案

```python
# 合并上下文
merged_context = _merge_context_values(ctx_by_dataset)

# 生成答案
answer = await completion_fn(query_text, merged_context)
```

---

## 七、会话缓存机制

TRIPLET_COMPLETION 和 EPISODIC 模式支持会话缓存：

```
get_completion()
  │
  ├─ 检查缓存是否启用 (CacheConfig.caching)
  │
  ├─ 如果启用:
  │    ├─ 获取对话历史 (get_conversation_history)
  │    ├─ 并行执行:
  │    │   ├─ 总结上下文 (summarize_text)
  │    │   └─ 生成 LLM 答案 (generate_completion)
  │    └─ 保存对话历史 (save_conversation_history)
  │
  └─ 如果未启用:
       └─ 直接生成 LLM 答案
```

---

## 八、搜索流程时序图

```
用户                      CLI/API                 核心调度                 模式路由                 检索器                  存储层
 │                         │                       │                       │                       │                       │
 │  mflow search "xxx"     │                       │                       │                       │                       │
 │────────────────────────>│                       │                       │                       │                       │
 │                         │                       │                       │                       │                       │
 │                         │  search()             │                       │                       │                       │
 │                         │──────────────────────>│                       │                       │                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │  get_recall_mode_tools()                       │                       │
 │                         │                       │──────────────────────>│                       │                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │  返回 [completion_fn, │                       │                       │
 │                         │                       │         context_fn]   │                       │                       │
 │                         │                       │<──────────────────────│                       │                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │  context_fn(query)    │                       │                       │
 │                         │                       │───────────────────────────────────────────────>│                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │                       │       向量搜索 + 图投影  │                       │
 │                         │                       │                       │───────────────────────────────────────────────>│
 │                         │                       │                       │<───────────────────────────────────────────────│
 │                         │                       │                       │                       │                       │
 │                         │                       │  返回上下文 (Edge[])  │                       │                       │
 │                         │                       │<───────────────────────────────────────────────│                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │  completion_fn(query, │                       │                       │
 │                         │                       │                context)│                       │                       │
 │                         │                       │───────────────────────────────────────────────>│                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │                       │   LLM 生成答案          │                       │
 │                         │                       │                       │──────────────────────>│                       │
 │                         │                       │                       │<──────────────────────│                       │
 │                         │                       │                       │                       │                       │
 │                         │                       │  返回答案              │                       │                       │
 │                         │                       │<───────────────────────────────────────────────│                       │
 │                         │                       │                       │                       │                       │
 │                         │  返回 SearchResult    │                       │                       │                       │
 │                         │<──────────────────────│                       │                       │                       │
 │                         │                       │                       │                       │                       │
 │  显示结果               │                       │                       │                       │                       │
 │<────────────────────────│                       │                       │                       │                       │
```
