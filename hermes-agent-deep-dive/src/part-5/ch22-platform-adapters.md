
# 第 22 章：Platform Adapter 模式

> **核心问题**：BasePlatformAdapter 的抽象设计？各平台适配器的差异化实现？

---

## 22.1 BasePlatformAdapter

- 源锚：`gateway/platforms/base.py`（2,071 行）
- 抽象方法：`start()`, `stop()`, `send_message()`, `receive_message()`
- `utf16_len()` — 跨平台文本长度计算
- `is_network_accessible()` — 网络可用性检测

> TODO: 基类的完整接口定义

---

## 22.2 主流平台适配器

| 平台 | 适配器 | 特殊处理 |
|------|--------|---------|
| Telegram | `telegram.py` | Bot API, 文件上传 |
| Discord | `discord.py` | Discord.py, 分片 |
| Slack | `slack.py` | Bolt SDK, 事件订阅 |

> TODO: 各平台的实现差异分析

---

## 22.3 中国平台适配器

| 平台 | 适配器 | 特殊处理 |
|------|--------|---------|
| DingTalk | `dingtalk.py` | 钉钉开放平台 |
| Feishu | `feishu.py` | 飞书开放平台 |
| WeCom | `wecom.py` | 企业微信 |
| WeChat | `wechat.py` | 微信公众号 |

> TODO: 中国平台的集成挑战

---

## 22.4 其他平台适配器

- WhatsApp, Signal, Matrix, BlueBubbles, SMS, Email, Mattermost, Webhook

> TODO: 长尾平台的适配策略

---

## 22.5 语音转录

- 跨平台语音消息处理
- 语音 → 文本转录

> TODO: 语音处理的跨平台统一

---

## 速查表

| 文件 | 角色 |
|------|------|
| `gateway/platforms/base.py` | BasePlatformAdapter 基类 |
| `gateway/platforms/telegram.py` | Telegram 适配器 |
| `gateway/platforms/discord.py` | Discord 适配器 |
| `gateway/platforms/slack.py` | Slack 适配器 |
| `gateway/platforms/` | 15 个平台适配器 |
