
# 第 9 章：错误分类、限流与路由降级

> **核心问题**：当 LLM API 返回错误时，Hermes 如何在毫秒级做出正确的恢复决策？是重试、换凭据、降级到备用模型，还是压缩上下文？

---

## 9.1 为什么需要错误分类器

一个 API 调用失败了。HTTP 状态码是 429。这意味着什么？

如果你的第一反应是"被限流了，等一会再试"，那你只对了一半。429 可能是：
- **速率限制**：每分钟请求数超限，等 60 秒就好
- **每日配额耗尽**：今天的额度用完了，等明天
- **账单问题**：信用额度不足，等多久都没用
- **Anthropic 的"长上下文层级"门控**：你的订阅等级不支持这个上下文长度

每种情况需要完全不同的恢复策略。速率限制需要退避重试；配额耗尽需要切换凭据；账单问题需要切换到备用提供商；上下文层级问题需要压缩上下文。

在 Hermes Agent v0.8.0 之前，这些判断分散在主循环的各个角落——几十个 `if "rate limit" in str(e)` 式的字符串匹配，散落在重试逻辑中。v0.8.0 引入了 `agent/error_classifier.py`，一个集中式的错误分类器，将所有错误判断统一到一个 810 行的模块中。

---

## 9.2 错误分类体系

### 9.2.1 FailoverReason 枚举

分类器的输出是一个 13 值的枚举——每个值对应一种错误的**根因**：

```python
# agent/error_classifier.py:25-58
class FailoverReason(enum.Enum):
    # 认证
    auth = "auth"                         # 瞬态认证错误（401/403）——刷新/轮换
    auth_permanent = "auth_permanent"     # 刷新后仍失败——放弃

    # 账单
    billing = "billing"                   # 402 或确认的额度耗尽——立即轮换
    rate_limit = "rate_limit"             # 429 或配额限流——退避后轮换

    # 服务端
    overloaded = "overloaded"             # 503/529——提供商过载
    server_error = "server_error"         # 500/502——内部错误

    # 传输
    timeout = "timeout"                   # 连接/读取超时——重建客户端

    # 上下文
    context_overflow = "context_overflow" # 上下文太大——压缩
    payload_too_large = "payload_too_large"  # 413——压缩载荷

    # 模型
    model_not_found = "model_not_found"   # 404 或无效模型——降级

    # 格式
    format_error = "format_error"         # 400 错误请求——放弃或修剪

    # 提供商特定
    thinking_signature = "thinking_signature"  # Anthropic thinking 块签名无效
    long_context_tier = "long_context_tier"    # Anthropic "额外用量"层级门控

    # 兜底
    unknown = "unknown"                   # 无法分类——退避重试
```

### 9.2.2 ClassifiedError 数据类

分类结果不仅包含原因，还包含四个**恢复动作提示**：

```python
# agent/error_classifier.py:63-84
@dataclass
class ClassifiedError:
    reason: FailoverReason
    status_code: Optional[int] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    message: str = ""
    error_context: Dict[str, Any] = field(default_factory=dict)

    # 恢复动作提示
    retryable: bool = True
    should_compress: bool = False
    should_rotate_credential: bool = False
    should_fallback: bool = False
```

这四个布尔值是分类器的**核心输出**。主循环不需要理解 13 种错误原因的语义——它只需要检查这四个标志：

- **`retryable`**：是否值得重试？`False` 意味着相同的请求会再次失败
- **`should_compress`**：是否需要压缩上下文？上下文溢出错误设此标志
- **`should_rotate_credential`**：是否需要切换到下一个凭据？限流和账单错误设此标志
- **`should_fallback`**：是否需要切换到备用提供商？严重错误设此标志

这些标志可以同时为 `True`——例如 `rate_limit` 既设 `retryable=True` 又设 `should_rotate_credential=True`，意思是"先换个凭据，然后重试"。

---

## 9.3 七步分类管道

`classify_api_error()` 是分类器的入口。它接收一个异常对象和上下文信息，通过七步优先级管道返回 `ClassifiedError`：

```python
# agent/error_classifier.py:222-395
def classify_api_error(error, *, provider="", model="", approx_tokens=0,
                        context_length=200000, num_messages=0):
    status_code = _extract_status_code(error)
    error_type = type(error).__name__
    body = _extract_error_body(error)
    error_code = _extract_error_code(body)
    # 构建综合错误消息用于模式匹配
    error_msg = _combine_message_sources(error, body)
```

### 第一步：提供商特定模式（最高优先级）

某些错误模式是特定提供商独有的，必须最先检测：

```python
# agent/error_classifier.py:317-338
# Anthropic thinking 块签名无效（400）
if (status_code == 400 and "signature" in error_msg and "thinking" in error_msg):
    return _result(FailoverReason.thinking_signature, retryable=True)

# Anthropic 长上下文层级门控（429 "extra usage" + "long context"）
if (status_code == 429 and "extra usage" in error_msg and "long context" in error_msg):
    return _result(FailoverReason.long_context_tier,
                   retryable=True, should_compress=True)
```

**Thinking 签名错误**发生在上下文压缩或消息合并使 thinking 块的签名失效时。这不是"你做错了"，而是"消息被修改过"——重试时适配器会剥离无效的 thinking 块（参见第 8 章 8.2.4 节）。

**长上下文层级门控**是 Anthropic 的订阅限制——Free 和 Pro 用户在使用超过一定上下文长度时需要 "extra usage" 层级。解决方案是压缩上下文使其低于层级阈值。

注意这两个检测**不限定 provider**——因为 OpenRouter 代理 Anthropic 时，`provider` 可能是 `"openrouter"`，但错误消息中的模式是 Anthropic 特有的。

### 第二步：HTTP 状态码分类

`_classify_by_status()` 根据状态码做初步分类，然后用消息模式**精炼**：

```python
# agent/error_classifier.py:400-504
def _classify_by_status(status_code, error_msg, error_code, body, ...):
    if status_code == 401:
        return result_fn(FailoverReason.auth, retryable=False,
                         should_rotate_credential=True, should_fallback=True)

    if status_code == 403:
        # OpenRouter 的 "key limit exceeded" 实际上是账单问题
        if "key limit exceeded" in error_msg or "spending limit" in error_msg:
            return result_fn(FailoverReason.billing, ...)
        return result_fn(FailoverReason.auth, ...)

    if status_code == 402:
        return _classify_402(error_msg, result_fn)

    if status_code == 429:
        return result_fn(FailoverReason.rate_limit, retryable=True,
                         should_rotate_credential=True, should_fallback=True)

    if status_code == 400:
        return _classify_400(error_msg, error_code, body, ...)

    if status_code in (500, 502):
        return result_fn(FailoverReason.server_error, retryable=True)

    if status_code in (503, 529):
        return result_fn(FailoverReason.overloaded, retryable=True)
```

几个值得注意的判断：

**401 不可重试**：这看似反直觉——如果凭据过期了，刷新后不就可以重试了吗？答案是：刷新逻辑在主循环中**先于** `retryable` 检查执行。如果刷新成功，循环 `continue` 直接重试。如果刷新失败，`retryable=False` 确保进入 fallback 路径而非无限重试。

**403 的歧义**：403 通常意味着"权限不足"，但 OpenRouter 用 403 表示"API Key 的消费限额用完了"——这实际上是 billing 问题。分类器通过消息模式区分这两种情况。

**400 是最复杂的状态码**——它可能意味着上下文溢出、模型不存在、格式错误、甚至速率限制（某些提供商用 400 而非 429）。`_classify_400()` 是一个 70 行的子函数，按优先级检查这些可能性。

### 第三步：402 歧义消解

402 Payment Required 是最需要精细化处理的状态码：

```python
# agent/error_classifier.py:507-533
def _classify_402(error_msg, result_fn):
    has_usage_limit = any(p in error_msg for p in _USAGE_LIMIT_PATTERNS)
    has_transient_signal = any(p in error_msg for p in _USAGE_LIMIT_TRANSIENT_SIGNALS)

    if has_usage_limit and has_transient_signal:
        # 瞬态配额——按速率限制处理
        return result_fn(FailoverReason.rate_limit, retryable=True, ...)

    # 确认的账单耗尽
    return result_fn(FailoverReason.billing, retryable=False, ...)
```

关键洞察（来自 OpenClaw 项目）：某些 402 是**伪装的速率限制**。"Usage limit, try again in 5 minutes" 不是账单问题——它是一个周期性配额，会自动重置。分类器通过检测"瞬态信号"（`_USAGE_LIMIT_TRANSIENT_SIGNALS`：`"try again"`、`"retry"`、`"resets at"`、`"window"` 等）来区分瞬态配额和真正的账单耗尽。

### 第四步：结构化错误码

某些 API 返回结构化的错误码（在 body 的 `error.code` 或 `error.type` 字段中），比 HTTP 状态码更精确：

```python
# agent/error_classifier.py:613-648
def _classify_by_error_code(error_code, error_msg, result_fn):
    code_lower = error_code.lower()
    if code_lower in ("resource_exhausted", "throttled", "rate_limit_exceeded"):
        return result_fn(FailoverReason.rate_limit, ...)
    if code_lower in ("insufficient_quota", "billing_not_active", "payment_required"):
        return result_fn(FailoverReason.billing, ...)
    if code_lower in ("model_not_found", "model_not_available", "invalid_model"):
        return result_fn(FailoverReason.model_not_found, ...)
    if code_lower in ("context_length_exceeded", "max_tokens_exceeded"):
        return result_fn(FailoverReason.context_overflow, ...)
```

### 第五步：消息模式匹配

当没有状态码或错误码时，分类器回退到八组模式列表进行文本匹配。以上下文溢出为例：

```python
# agent/error_classifier.py:147-163
_CONTEXT_OVERFLOW_PATTERNS = [
    "context length", "context size", "maximum context",
    "token limit", "too many tokens", "reduce the length",
    "exceeds the limit", "context window", "prompt is too long",
    "prompt exceeds max length", "max_tokens",
    "maximum number of tokens",
    "超过最大长度",    # 中文错误消息
    "上下文长度",      # 某些提供商返回中文
]
```

注意最后两行——某些中国提供商（如 DashScope/通义千问）返回中文错误消息。分类器必须覆盖这些多语言模式。

其他模式列表还包括：

- `_BILLING_PATTERNS`（10 个模式）：`"insufficient credits"`、`"payment required"`、`"exceeded your current quota"` 等
- `_RATE_LIMIT_PATTERNS`（11 个模式）：`"rate limit"`、`"too many requests"`、`"requests per minute"` 等
- `_AUTH_PATTERNS`（8 个模式）：`"invalid api key"`、`"token expired"`、`"access denied"` 等
- `_MODEL_NOT_FOUND_PATTERNS`（7 个模式）：`"model not found"`、`"unsupported model"` 等
- `_PAYLOAD_TOO_LARGE_PATTERNS`（3 个模式）：检测代理/后端在消息文本中嵌入的 413 状态码

### 第六步：服务器断连 + 大会话启发式

这一步处理一个微妙的场景——服务器在处理大请求时断开连接：

```python
# agent/error_classifier.py:377-386
is_disconnect = any(p in error_msg for p in _SERVER_DISCONNECT_PATTERNS)
if is_disconnect and not status_code:
    is_large = (approx_tokens > context_length * 0.6
                or approx_tokens > 120000
                or num_messages > 200)
    if is_large:
        return _result(FailoverReason.context_overflow,
                       retryable=True, should_compress=True)
    return _result(FailoverReason.timeout, retryable=True)
```

`_SERVER_DISCONNECT_PATTERNS` 包括 `"server disconnected"`、`"peer closed connection"`、`"connection reset by peer"`、`"unexpected eof"` 等。

当断连发生在大会话（>60% 上下文窗口，或 >120K token，或 >200 条消息）中时，更可能是**上下文溢出**而非普通的网络故障。某些提供商在检测到请求太大时直接断开连接而不是返回 400——没有 HTTP 状态码，只有一个传输层错误。

**这一步必须在传输错误检测（第七步）之前**。否则 `RemoteProtocolError` 会被通用地映射到 `timeout`，而不是更精准的 `context_overflow`。

### 第七步：传输错误与兜底

```python
# agent/error_classifier.py:390-395
if error_type in _TRANSPORT_ERROR_TYPES or isinstance(error, (TimeoutError, ...)):
    return _result(FailoverReason.timeout, retryable=True)

# 兜底：无法分类的错误
return _result(FailoverReason.unknown, retryable=True)
```

`_TRANSPORT_ERROR_TYPES` 是一个 14 种错误类名的集合——从 Python 内置的 `TimeoutError` 到 OpenAI SDK 的 `APIConnectionError`。所有传输错误都被视为可重试的。

兜底分支也是可重试的——面对未知错误，乐观地假设重试可能成功总比立即放弃要好。

---

## 9.4 错误消息的提取与组合

分类管道的输入质量取决于它能从异常对象中提取多少信息。这个过程比看起来要复杂得多：

```python
# agent/error_classifier.py:267-296
_raw_msg = str(error).lower()
_body_msg = ""
_metadata_msg = ""
if isinstance(body, dict):
    _err_obj = body.get("error", {})
    if isinstance(_err_obj, dict):
        _body_msg = (_err_obj.get("message") or "").lower()
        # 解析 metadata.raw 中包装的提供商错误
        _metadata = _err_obj.get("metadata", {})
        if isinstance(_metadata, dict):
            _raw_json = _metadata.get("raw") or ""
            # OpenRouter 将上游错误包装在 metadata.raw 中
            _inner = json.loads(_raw_json)
            _inner_err = _inner.get("error", {})
            _metadata_msg = (_inner_err.get("message") or "").lower()
```

三层消息来源被组合：

1. **`str(error)`**：异常的字符串表示，可能不包含 body 消息
2. **`body.error.message`**：结构化 body 中的错误消息
3. **`body.error.metadata.raw`**：OpenRouter 特有——它将上游提供商（Anthropic、OpenAI）的错误 JSON 包装在 `metadata.raw` 字段中。真正的错误消息（比如"context length exceeded"）只存在于这个内层 JSON 中

状态码的提取同样需要遍历异常链：

```python
# agent/error_classifier.py:744-761
def _extract_status_code(error):
    current = error
    for _ in range(5):  # 最多 5 层，防止无限循环
        code = getattr(current, "status_code", None)
        if isinstance(code, int):
            return code
        code = getattr(current, "status", None)
        if isinstance(code, int) and 100 <= code < 600:
            return code
        cause = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
        if cause is None or cause is current:
            break
        current = cause
    return None
```

某些 SDK 用 `.status_code`，某些用 `.status`。异常可能被包装了多层（`APIStatusError.__cause__ = httpx.HTTPStatusError`）。代码遍历最多 5 层异常链来找到状态码。

---

## 9.5 主循环中的错误处理

分类器是独立的——它不做任何恢复动作，只提供建议。实际的恢复逻辑在 `run_conversation()` 的重试循环中（参见第 5 章 5.7 节）。让我们追踪一个完整的错误处理流程。

当 API 调用抛出异常：

1. **分类**：`classify_api_error(e, provider=..., model=..., approx_tokens=...)` 返回 `ClassifiedError`

2. **凭据轮换**（如果 `should_rotate_credential`）：

```python
# run_agent.py 错误处理逻辑（概念性伪代码）
if classified.should_rotate_credential and credential_pool:
    next_cred = credential_pool.mark_exhausted_and_rotate(
        status_code=classified.status_code,
        error_context={"reason": classified.reason.value, "message": classified.message},
    )
    if next_cred:
        # 更新 API key 和客户端，continue 重试
        ...
```

`mark_exhausted_and_rotate()` 做三件事：把当前凭据标记为 exhausted、清除当前选择、调用 `_select_unlocked()` 选择下一个可用凭据。如果找到新凭据，循环 `continue` 用新凭据重试。

3. **上下文压缩**（如果 `should_compress`）：

```python
if classified.should_compress:
    messages, system_prompt = self._compress_context(messages, system_prompt, ...)
    continue  # 用压缩后的上下文重试
```

4. **Fallback 激活**（如果 `should_fallback`）：

```python
if classified.should_fallback and self._fallback_chain:
    if self._try_activate_fallback():
        continue  # 用备用提供商重试
```

5. **退避重试**（如果 `retryable`）：

```python
if classified.retryable and retry_count < max_retries:
    delay = base_delay * (2 ** retry_count) + random.uniform(0, 1)  # 抖动退避
    time.sleep(delay)
    continue
```

6. **放弃**：如果以上都不适用或都失败了，显示错误消息并退出循环。

这些步骤的顺序很关键——**凭据轮换先于 fallback**（因为同一提供商的另一个凭据可能还有配额），**fallback 先于重试**（因为换提供商比等待更快），**压缩先于所有涉及上下文溢出的重试**（否则相同的大请求会继续失败）。

---

## 9.6 Fallback 链

主循环在初始化时构建 fallback 链：

```python
# run_agent.py:950-973
if isinstance(fallback_model, list):
    self._fallback_chain = [
        f for f in fallback_model
        if isinstance(f, dict) and f.get("provider") and f.get("model")
    ]
elif isinstance(fallback_model, dict) and fallback_model.get("provider") and fallback_model.get("model"):
    self._fallback_chain = [fallback_model]
else:
    self._fallback_chain = []
self._fallback_index = 0
self._fallback_activated = False
```

支持两种配置格式——单个 fallback 字典（旧格式）和 fallback 列表（新格式）。列表格式支持多级降级链：

```yaml
fallback_providers:
  - provider: anthropic
    model: claude-sonnet-4
  - provider: openrouter
    model: google/gemini-2.0-flash
```

`_try_activate_fallback()` 沿着链向下走，每次激活下一个提供商。激活意味着：更新 `self.model`、`self.api_key`、`self.base_url`、`self.provider`，重建 API 客户端，更新 context engine 的模型信息。

Fallback 是**单向的**——一旦激活备用提供商，不会自动回到主提供商。这是有意为之：如果主提供商在会话中间故障，回切可能造成不一致（不同模型对同一对话的理解不同）。用户可以用 `/model` 命令手动切换回来。

---

## 9.7 400 错误的深度分类

400 Bad Request 是所有状态码中最模糊的——它可以意味着十种不同的事情。`_classify_400()` 按优先级检查：

```python
# agent/error_classifier.py:536-608
def _classify_400(error_msg, error_code, body, *, provider, model,
                   approx_tokens, context_length, num_messages, result_fn):
    # 1. 上下文溢出模式
    if any(p in error_msg for p in _CONTEXT_OVERFLOW_PATTERNS):
        return result_fn(FailoverReason.context_overflow, should_compress=True)

    # 2. 模型不存在（某些提供商用 400 而非 404）
    if any(p in error_msg for p in _MODEL_NOT_FOUND_PATTERNS):
        return result_fn(FailoverReason.model_not_found, should_fallback=True)

    # 3. 速率限制（某些提供商用 400 而非 429）
    if any(p in error_msg for p in _RATE_LIMIT_PATTERNS):
        return result_fn(FailoverReason.rate_limit, should_rotate_credential=True)

    # 4. 账单问题
    if any(p in error_msg for p in _BILLING_PATTERNS):
        return result_fn(FailoverReason.billing, should_rotate_credential=True)

    # 5. 通用 400 + 大会话 → 可能的上下文溢出
    is_generic = len(err_body_msg) < 30 or err_body_msg in ("error", "")
    is_large = (approx_tokens > context_length * 0.4
                or approx_tokens > 80000
                or num_messages > 80)
    if is_generic and is_large:
        return result_fn(FailoverReason.context_overflow, should_compress=True)

    # 6. 兜底：格式错误
    return result_fn(FailoverReason.format_error, retryable=False, should_fallback=True)
```

第 5 条规则特别巧妙——当 400 响应的错误消息很短（少于 30 字符）或只是一个光秃秃的 "Error"，而且当前会话很大时，分类器推测这可能是一个没有明确错误消息的上下文溢出。Anthropic 在某些边界情况下就会返回这种模糊的 400。

阈值是保守的——`approx_tokens > context_length * 0.4` 意味着上下文需要超过窗口的 40% 才会触发这个推测。在小会话中，同样的模糊 400 会被分类为 `format_error`。

---

## 9.8 限流处理的完整流程

让我们追踪一个 429 错误从发生到恢复的完整流程：

1. **API 返回 429**，`classify_api_error()` 返回：
   ```
   ClassifiedError(reason=rate_limit, retryable=True,
                   should_rotate_credential=True, should_fallback=True)
   ```

2. **凭据池轮换**：`credential_pool.mark_exhausted_and_rotate(status_code=429)` 标记当前凭据为 exhausted。冷却时间默认为 `EXHAUSTED_TTL_429_SECONDS = 3600` 秒（1 小时），但如果错误消息中有 `quotaResetDelay:300000ms`，冷却时间改为 300 秒。选择下一个可用凭据。

3. **如果有新凭据**：用新凭据重建客户端，`continue` 重试。通常这次就成功了——限流是针对单个 API Key 的，换一个 Key 通常可以绕过。

4. **如果所有凭据都 exhausted**：尝试 fallback 链。`_try_activate_fallback()` 切换到备用提供商（比如从 Anthropic 切换到 OpenRouter）。

5. **如果没有 fallback**：进入退避循环。延迟 = `base_delay × 2^retry_count + random(0, 1)`。重试直到成功或达到最大重试次数。

6. **如果重试也失败**：向用户报告错误。但凭据池中的 exhausted 凭据会在冷却到期后自动恢复——下次 API 调用时 `_available_entries(clear_expired=True)` 会检查冷却到期并重置状态。

---

## 9.9 上下文溢出的特殊处理

上下文溢出与其他错误的恢复路径根本不同——它不是"换个凭据"或"等一会再试"能解决的。同样的请求发到任何提供商都会失败，因为问题在请求本身。

当 `should_compress=True` 时：

1. `_compress_context()` 被调用（参见第 7 章），将消息列表压缩
2. Context engine 的 `context_length` 可能被下调（第 5 章中的"context probing"——探测实际的上下文上限）
3. 用压缩后的消息列表重试

如果压缩后仍然溢出（极端情况——System Prompt 本身就接近上下文限制），会话可能需要用户手动干预（`/new` 开始新会话）。

`thinking_signature` 错误也有独特的恢复路径——它不需要压缩或换凭据，而是需要在下次发送时**剥离无效的 thinking 块**。适配器层自动处理这个（第 8 章 8.2.4 节），所以分类器只设 `retryable=True`。

---

## 9.10 OpenRouter 的错误包装

OpenRouter 作为多提供商代理，会将上游提供商的错误包装在一个额外的 JSON 层中：

```json
{
  "error": {
    "message": "Provider returned error",
    "code": 429,
    "metadata": {
      "raw": "{\"error\":{\"message\":\"Rate limit exceeded for model claude-sonnet-4...\",\"type\":\"rate_limit_error\"}}"
    }
  }
}
```

外层的 `"Provider returned error"` 几乎没有信息量——真正的错误消息在 `metadata.raw` 的 JSON 字符串中。分类器的消息提取逻辑会解析这个嵌套 JSON（第 275-288 行），将内层消息加入模式匹配池。

没有这个解析，通过 OpenRouter 使用 Anthropic 时的上下文溢出错误会被误分类为通用的 `format_error`（因为外层消息不包含 `"context length"` 等关键词）。

---

## 9.11 模型降级策略

当错误触发 `should_fallback=True` 时，降级有两个维度：

**维度 1：同一提供商内降级**。凭据池轮换在 fallback 之前执行。如果用户有两个 Anthropic API Key，第一个限流后第二个可能还有配额。这是最优的降级——同一个模型，同一个 API 格式，只是换了一个 Key。

**维度 2：跨提供商降级**。Fallback 链定义了提供商间的降级顺序。典型配置：

- **主提供商**：Anthropic Claude Opus 4.6（最强，最贵）
- **Fallback 1**：Anthropic Claude Sonnet 4（同提供商，便宜一点）
- **Fallback 2**：OpenRouter → Google Gemini 2.0 Flash（不同提供商，更便宜）

跨提供商降级时，`api_mode` 可能也需要切换（从 `anthropic_messages` 到 `chat_completions`），客户端需要完全重建。Context engine 的 `update_model()` 被调用来更新上下文窗口和压缩阈值。

降级是有代价的——cheaper 模型的推理能力通常更弱。但在主模型完全不可用时，用一个能力稍弱但可用的模型远好于什么都不做。

---

## 9.12 与 Smart Routing 的交互

错误分类和 Smart Routing（第 8 章 8.4 节）之间有一个交互：如果 cheap 模型路由失败了，错误应该触发**回退到 strong 模型**而非 fallback 链。

这是因为 cheap 模型通常更有限——它可能不支持某些工具调用格式，或者有更小的上下文窗口。cheap 路由失败不意味着整个提供商不可用，只意味着这条消息对 cheap 模型来说不够"简单"。

主循环在 smart routing 路径上的错误处理会先检查是否正在使用 cheap 路由，如果是，则恢复到 primary 模型而不是激活 fallback。只有 primary 模型也失败时，才走 fallback 链。

---

## 速查表

| 文件 | 角色 |
|------|------|
| `agent/error_classifier.py` | 错误分类器，810 行。7 步管道、13 种 FailoverReason、4 个恢复标志 |
| `agent/credential_pool.py` | 凭据池，1357 行。`_mark_exhausted()`、`mark_exhausted_and_rotate()` |
| `run_agent.py:950-973` | Fallback 链初始化 |
| `FailoverReason` | 13 值枚举：auth, billing, rate_limit, overloaded, server_error, timeout, context_overflow, payload_too_large, model_not_found, format_error, thinking_signature, long_context_tier, unknown |
| `ClassifiedError` | 分类结果数据类：reason + retryable + should_compress + should_rotate_credential + should_fallback |
| `_BILLING_PATTERNS` | 10 个账单耗尽模式 |
| `_RATE_LIMIT_PATTERNS` | 11 个速率限制模式 |
| `_CONTEXT_OVERFLOW_PATTERNS` | 13 个上下文溢出模式（含中文） |
| `_SERVER_DISCONNECT_PATTERNS` | 7 个服务器断连模式 |
| `_TRANSPORT_ERROR_TYPES` | 14 种传输错误类名 |
| `EXHAUSTED_TTL_429_SECONDS` | 429 冷却：3600 秒 |
| `EXHAUSTED_TTL_DEFAULT_SECONDS` | 默认冷却：3600 秒 |
