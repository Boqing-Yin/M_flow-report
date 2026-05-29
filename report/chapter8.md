# 本地部署情况报告
## 基本部署信息

| **Python**    | 3.12.3（虚拟环境）   |
| ------------- | -------------- |
| **OS**        | Linux          |
| **RAM**       | 4 GB           |
| **LLM**       | DeepSeek/v4pro |
| **EMBEDDING** | fastembed      |


## 测试结果展示
### tset1-基础连接测试：
- 测试文件
```python
async def main():  
    # 1. 写入我们设计的“连环线索”
    await m_flow.add("小明最喜欢的运动是打篮球。")
    await m_flow.add("小红在小明生日那天，送了他一件他最喜欢运动的装备。")
    await m_flow.add("小刚送了小明一本书。")
    # 2. 触发 M-Flow 整理并构建知识图谱（这一步会调用大模型）
  
    await m_flow.memorize()
    # 3. 提问测试
    question = "小红送给小明的生日礼物可能是什么？"
 
    # 4. 执行多跳图路由检索
    results = await m_flow.search(question)
    print("\n--- 检索到的相关记忆片段 ---")
```
- 根据三个线索（2 个有效，1 个干扰）：
   `小明最喜欢的运动是打篮球`
   `小红在小明生日那天，送了他一件他最喜欢运动的装备`
   `小刚送了小明一本书`
	输出了`篮球装备`的正确答案。
- 输出约耗时`30s`
### test2-针对性（监控图像情景）测试
- 测试文件
```python
video_events = [
        "时间：09:15 | 地点：东门 | 行人：P-101 | 特征：男性，蓝色卫衣 | 携带物品：棕色纸袋。",
        "时间：10:00 | 地点：3号楼大堂 | 行人：P-101 | 特征：蓝色卫衣 | 携带物品：无。",
        "时间：10:15 | 地点：3号楼大堂 | 发现遗留物：长椅上出现了一个无人看管的棕色纸袋。",
        "时间：10:30 | 地点：3号楼大堂 | 行人：P-102 | 特征：女性，黄色外套 | 携带物品：带走了棕色纸袋。"
    ]

    # 2. 写入记忆
    ...
    # 3. 运行测试问题集
    test_queries = [
        "P-101在09:15时携带了什么物品？", # 难度1
        "3号楼长椅上遗留的棕色纸袋最可能是谁落下的？", # 难度2
        "棕色纸袋是在什么时间段内被遗落的？" # 难度3
    ]
	# 4. 输出结果
	...
```
- 这是一个针对实际运用情景的试探性测试，设计了三个不同难度的问题，来让 M_flow 解答。
- 回答结果展示如下：
```
===============================================
P-101在09:15时携带了什么物品？(预期回答：棕色纸袋)
召回线索 [1]: {'search_result': ['Context does not provide information about P-101 at 09:15.'], 'dataset_id': '9403e96c-b3b6-55f8-a052-06211dc305ce', 'dataset_name': 'main_dataset', 'dataset_tenant_id': None}

===============================================
3号楼长椅上遗留的棕色纸袋最可能是谁落下的？(预期回答：P-101)
召回线索 [1]: {'search_result': ['最可能是行人P-102落下的。'], 'dataset_id': '9403e96c-b3b6-55f8-a052-06211dc305ce', 'dataset_name': 'main_dataset', 'dataset_tenant_id': None}

===============================================
棕色纸袋是在什么时间段内被遗落的？(预期回答：9:15-10:00)
召回线索 [1]: {'search_result': ['棕色纸袋于10:15在3号楼大堂长椅上被遗落。'], 'dataset_id': '9403e96c-b3b6-55f8-a052-06211dc305ce', 'dataset_name': 'main_dataset', 'dataset_tenant_id': None}
```
可以看到，回答十分混乱。对于三个难度层级都没有回答正确。**分析后发现是向量模型不支持中文语义**的原因。采用**英文**的记忆输入和提问后，测试结果如下。
```
===============================================
Question: What item did P-101 carry at 09:15?(except answer:brown paper bag)
Answer: ['brown paper bag']

===============================================
Question: Who is the most likely owner of the brown paper bag left on the bench in Building 3?(except answer:P-101)
Answer: ['The most likely owner of the brown paper bag is P-101, who was observed carrying it at the East Gate at 09:15 and was last seen in Building 3 lobby at 10:00 without the bag.']

===============================================
Question: In what time window was the brown paper bag lost or misplaced?(except answer:09:15 to 10:00)
Answer: ['The brown paper bag was likely lost or misplaced between 09:15 and 10:15 on May 26, 2026.']
```
可以看到，只在最难的第三个问题上出现了一点错误。模型的能力是值得认可的，但是要达到更加可靠的复杂时空推理需求，还需要深度的个性化定制。
### test3-多模式测试
因为模型具有五种不同的推理模式。我将五种模式都轮流用了一遍，测试上一个部分相同的问题。测试结果如下：
问题1：
```
Question: What item did P-101 carry at 09:15?

=== Mode: EPISODIC ===
Returned 1 result(s):
[1] ['brown paper bag']

=== Mode: PROCEDURAL ===
Returned 1 result(s):
[1] ['The context lacks sufficient information to answer this question.']

=== Mode: TRIPLET_COMPLETION ===
Returned 1 result(s):
[1] ['brown paper bag']

=== Mode: CHUNKS_LEXICAL ===
Returned 1 result(s):
[1] [[{'name': '', 'type': 'ContentFragment', 'version': 1, 'metadata': {'index_fields': ['text'], 'sentence_classifications': [{'sentence_idx': 0, 'text': 'Time: 09:15 | Location: East Gate | Pedestrian: P-101 | Features: Male, blue hoodie | Carried item: brown paper bag.', 'routing_type': 'atomic', 'event_id': 'atomic_1ce722f7-be28-5296-bb20-79839ad09225_0_441a30', 'event_topic': '[Atomic] Time: 09:15 | Location: East Gate | Pedestrian: P-...', 'event_focus': 'Short single sentence - atomic processing'}]}, 'schema_aligned': False, 'graph_depth': 0, 'memory_spaces': None, 'mentioned_time_start_ms': None, 'mentioned_time_end_ms': None, 'mentioned_time_confidence': None, 'mentioned_time_text': None, 'text': 'Time: 09:15 | Location: East Gate | Pedestrian: P-101 | Features: Male, blue hoodie | Carried item: brown paper bag.', 'chunk_size': 53, 'chunk_index': 0, 'cut_type': 'sentence_end', 'contains': [], 'created_at': 1779808247298, 'updated_at': 1779837087507}, {'name': '', 'type': 'ContentFragment', 'version': 1, 'metadata': {'index_fields': ['text'], 'sentence_classifications': [{'sentence_idx': 0, 'text': 'Time: 10:00 | Location: Building 3 Lobby | Pedestrian: P-101 | Features: Blue hoodie | Carried item: None.', 'routing_type': 'atomic', 'event_id': 'atomic_ce57f751-9be5-52f2-b338-a08cf89871f0_0_e24ca1', 'event_topic': '[Atomic] Time: 10:00 | Location: Building 3 Lobby | Pedestr...', 'event_focus': 'Short single sentence - atomic processing'}]}, 'schema_aligned': False, 'graph_depth': 0, 'memory_spaces': None, 'mentioned_time_start_ms': None, 'mentioned_time_end_ms': None, 'mentioned_time_confidence': None, 'mentioned_time_text': None, 'text': 'Time: 10:00 | Location: Building 3 Lobby | Pedestrian: P-101 | Features: Blue hoodie | Carried item: None.', 'chunk_size': 48, 'chunk_index': 0, 'cut_type': 'sentence_end', 'contains': [], 'created_at': 1779808247813, 'updated_at': 1779837104285}, {'name': '', 'type': 'ContentFragment', 'version': 1, 'metadata': {'index_fields': ['text'], 'sentence_classifications': [{'sentence_idx': 0, 'text': 'Time: 10:15 | Location: Building 3 Lobby | Unattended item found: A brown paper bag left on the bench.', 'routing_type': 'atomic', 'event_id': 'atomic_d93cef27-b772-5185-ad68-2d34e5aeb578_0_b46363', 'event_topic': '[Atomic] Time: 10:15 | Location: Building 3 Lobby | Unatten...', 'event_focus': 'Short single sentence - atomic processing'}]}, 'schema_aligned': False, 'graph_depth': 0, 'memory_spaces': None, 'mentioned_time_start_ms': None, 'mentioned_time_end_ms': None, 'mentioned_time_confidence': None, 'mentioned_time_text': None, 'text': 'Time: 10:15 | Location: Building 3 Lobby | Unattended item found: A brown paper bag left on the bench.', 'chunk_size': 45, 'chunk_index': 0, 'cut_type': 'sentence_end', 'contains': [], 'created_at': 1779808248306, 'updated_at': 1779837114778}, {'name': '', 'type': 'ContentFragment', 'version': 1, 'metadata': {'index_fields': ['text'], 'sentence_classifications': [{'sentence_idx': 0, 'text': 'Time: 10:30 | Location: Building 3 Lobby | Pedestrian: P-102 | Features: Female, yellow jacket | Carried item: took the brown paper bag from the bench.', 'routing_type': 'episodic', 'event_id': 'evt_824c6da1-7254-5990-84a9-abb067d000bc_52f37696', 'event_topic': 'Single sentence content', 'event_focus': 'Single sentence - direct episodic processing'}]}, 'schema_aligned': False, 'graph_depth': 0, 'memory_spaces': None, 'mentioned_time_start_ms': None, 'mentioned_time_end_ms': None, 'mentioned_time_confidence': None, 'mentioned_time_text': None, 'text': 'Time: 10:30 | Location: Building 3 Lobby | Pedestrian: P-102 | Features: Female, yellow jacket | Carried item: took the brown paper bag from the bench.', 'chunk_size': 66, 'chunk_index': 0, 'cut_type': 'sentence_end', 'contains': [], 'created_at': 1779808248772, 'updated_at': 1779837073471}]]

=== Mode: CYPHER ===
Error during search: CypherExecutionError CypherExecutionError: Cypher query execution failed. (Status code: 400)
```
问题2
```
Question: Who is the most likely owner of the brown paper bag left on the bench in Building 3?

=== Mode: EPISODIC ===
Returned 1 result(s):
[1] ['The most likely owner is Pedestrian P-101, who was seen carrying a brown paper bag at 09:15 and then in Building 3 lobby without it at 10:00, shortly before the bag was found unattended.']

=== Mode: PROCEDURAL ===
Returned 1 result(s):
[1] ['Insufficient context to determine the owner of the brown paper bag.']

=== Mode: TRIPLET_COMPLETION ===
Returned 1 result(s):
[1] ['The context does not provide any information about who might own the bag; it only states that an unattended bag was found.']

=== Mode: CHUNKS_LEXICAL ===
Returned 1 result(s):
[1] [[{'name': '', 'type': 'ContentFragment', 'version': 1, 
......(此处省略很多，和问题1一样)
sentence_end', 'contains': [], 'created_at': 1779808247813, 'updated_at': 1779837104285}]]

=== Mode: CYPHER ===
Error during search: CypherExecutionError CypherExecutionError: Cypher query execution failed. (Status code: 400)
```
问题3
```
Question: In what time window was the brown paper bag lost or misplaced?

=== Mode: EPISODIC ===
Returned 1 result(s):
[1] ['The bag was lost between 09:15 and 10:00, and was found unattended at 10:15.']

=== Mode: PROCEDURAL ===
Returned 1 result(s):
[1] ['The provided context does not contain any information about a brown paper bag or its loss, so it is not possible to determine the time window.']

=== Mode: TRIPLET_COMPLETION ===
Returned 1 result(s):
[1] ['The context only indicates that the brown paper bag was found unattended at 10:15, not the time it was lost or misplaced.']

=== Mode: CHUNKS_LEXICAL ===
Returned 1 result(s):
[1] [[{'name': '', 'type': 'ContentFragment', 'version': 1,  
（此处省略很多）.....
'created_at': 1779808247813, 'updated_at': 1779837104285}]]

=== Mode: CYPHER ===
Error during search: CypherExecutionError CypherExecutionError: Cypher query execution failed. (Status code: 400)
```
**可以看出，各种模式的使用还需要进行个性化配置**，并不能达到开箱即用。

## 部署时候遇到的问题（避坑指南）

### **Docker 与网络环境依赖**：
M-Flow 官方提供了基于 Docker Compose 的一键部署脚本（如 `quickstart.sh`），但对于国内开发者，在拉取官方 DockerHub 镜像（如 `python:3.12-slim-bookworm` 和 `node:20-alpine`）时，我遭遇 DNS 解析错误和超时报错（如 `dial tcp: lookup registry-1.docker.io...`）。因此体验其给出的UI界面简洁化部署失败了。
### **Pip 代理冲突**
根据其官方文档，其部署方式是采用`pip install m_flow`的指令。
但我实际进行部署的时候，发现找不到相应的包。而是采用`pip install mflow-ai`才安装成功的。
### 配置文件（.env）解析歧义与校验失败
在配置 `VECTOR_DB_URL=` 后紧跟空格及井号注释时，Pydantic 报错 `ValidationError` 提示需要绝对路径。
 **解决**：由于 M-Flow 内置的某些文件解析器处理不严谨，会将未用双引号包裹的尾随注释误识别为变量的实际参数。需将 `VECTOR_DB_URL` 显式设置为空字符串（即 `VECTOR_DB_URL=""`）并移除尾随注释。

### 大模型（LLM）调用与“深度思考”模式冲突
*   **现象**：当使用集成了 DeepSeek 最新模型的 API 端点（如 `api.deepseek.com`），且设置 `LLM_INSTRUCTOR_MODE="tool_call"` 时，程序频繁报错 `litellm.BadRequestError: Thinking mode does not support this tool_choice`。
*   **原因与解决**：
    这是大模型技术演进引发的最典型前沿冲突。DeepSeek 等新型大模型默认开启了“深度思考模式（Thinking Mode）”，而该模式在协议上**不支持强制工具调用（Forced tool_choice）** 。
    *   **解决方案**：将 `LLM_INSTRUCTOR_MODE` 修改为 **`"json_mode"`** 。这样系统会改用兼容思考链的标准 JSON 对象（`json_object`）输出形式，在保证思考推理深度的同时避开协议冲突 。
    
### 向量嵌入（Embedding）缺省造成的程序死锁
*   **现象**：大模型自检通过后，程序运行到 `Default permissions initialized` 处无任何日志输出，呈现长期卡死/死锁状态。
*   **原因与解决**：
    若用户仅配置了 LLM 密钥而未声明 Embedding 配置，系统会默认尝试用同一个 API 端点和 Key 去请求默认的 OpenAI 嵌入接口 。而类似 DeepSeek 的官方接口并不提供向量嵌入（`/v1/embeddings`）服务，导致底层请求失败。由于 `tenacity` 自动重试机制的存在，系统开始进行无报错的静默无限重试 。
    *   **解决方案**：引入本地运行且不需要 API 密钥的 **`fastembed`** 库，将 `EMBEDDING_PROVIDER` 指定为 `"fastembed"` 。
    *   **避坑防崩**：`fastembed` 默认调用的 `BAAI/bge-small-en-v1.5` 输出维度是 **384 维**，必须将 `.env` 里的 `EMBEDDING_DIMENSIONS` 同步修改为 `384`（而不是 OpenAI 的 3072）。否则，LanceDB 数据库写入时将因维度冲突彻底崩溃。

### 中文环境语义漂移
*   **现象**：用中文记录测试时，系统经常回答“未找到相关信息”。
*   **原因与解决**：
    默认使用的 `bge-small-en-v1.5` 是纯英文向量模型。
    *   **解决方案 1**：将 `.env` 的向量模型替换为多语言模型，如 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`（输出同样为 384 维，无需修改维度）。
    *   **解决方案 2（学术推荐）**：由于底层关系抽取的系统 Prompts 是英文，最稳妥、能最大化发挥 M-Flow 时空关联逻辑的设计是将**输入数据流与提问全部转化为英文运行**，规避因中英语义漂移产生的抽取失败。
