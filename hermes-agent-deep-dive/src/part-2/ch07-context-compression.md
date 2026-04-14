
# 第 7 章：上下文压缩与 Context Engine

> **核心问题**：ContextEngine 的可插拔设计如何工作？默认压缩器的五步算法是什么？

---

## 7.1 ContextEngine 抽象基类

- 源锚：`agent/context_engine.py` — `class ContextEngine`
- 抽象接口：`compress()`, `should_compress()`, `get_stats()`

> TODO: 接口定义与职责边界

---

## 7.2 默认压缩器：ContextCompressor

- 源锚：`agent/context_compressor.py`
- 五步压缩算法：
  1. 评估当前上下文大小
  2. 选择可压缩消息
  3. LLM 摘要生成
  4. 替换原始消息
  5. 迭代更新摘要前缀

> TODO: 五步算法详解与伪代码

---

## 7.3 SUMMARY_PREFIX 机制

- `SUMMARY_PREFIX` — 摘要消息的标识前缀
- 迭代更新策略：新摘要合并旧摘要

> TODO: 摘要迭代的数据流图

---

## 7.4 压缩触发条件

- token 计数阈值
- 模型上下文窗口感知

> TODO: 触发条件的配置与计算

---

## 7.5 自定义 ContextEngine

- 插件化替换默认压缩器
- 源锚：`agent/context_engine.py`

> TODO: 扩展接口指南

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/context_engine.py` | ContextEngine 抽象基类 |
| `agent/context_compressor.py` | 默认压缩器实现 |
