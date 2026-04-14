
# 第 29 章：RL 训练与 Trajectory 生成

> **核心问题**：batch_runner 和 Atropos 环境如何为 Agent 强化学习服务？

---

## 29.1 Trajectory 生成

- 源锚：`agent/trajectory.py`
- 会话轨迹的记录与保存
- 轨迹格式

> TODO: 轨迹数据的结构与存储

---

## 29.2 Batch Runner

- 源锚：`batch_runner.py`
- 批量并行轨迹生成
- 多场景并发执行

> TODO: batch_runner 的架构与使用

---

## 29.3 Trajectory Compressor

- 源锚：`trajectory_compressor.py`
- 轨迹压缩与精简
- 训练数据优化

> TODO: 压缩算法与数据质量平衡

---

## 29.4 Atropos RL 环境

- 源锚：`environments/`
- tinker-atropos 子模块
- RL 训练环境接口
- `rl_cli.py` — RL 命令行入口

> TODO: Atropos 环境的集成架构

---

## 29.5 训练流水线

- 数据收集 → 轨迹压缩 → RL 训练 → 模型更新

> TODO: 端到端训练流水线

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/trajectory.py` | 轨迹记录 |
| `batch_runner.py` | 批量轨迹生成 |
| `trajectory_compressor.py` | 轨迹压缩 |
| `environments/` | RL 训练环境 |
| `rl_cli.py` | RL 命令行入口 |
