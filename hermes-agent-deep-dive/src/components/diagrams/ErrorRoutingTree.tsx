/**
 * ErrorRoutingTree — ch09 错误分类决策树 + failover 路径
 */
import StageFlow from '../shared/StageFlow';
import type { Stage } from '../shared/StageFlow';

const stages: Stage[] = [
  { title: '① 错误捕获', subtitle: 'try/except 在 API 调用层', section: '§9.2', detail: 'API 调用被 try/except 包裹。捕获所有异常后，进入分类器：根据异常类型和 HTTP 状态码判断错误类别。不同类别触发不同的恢复策略。', funcs: ['_interruptible_streaming_api_call()', 'APIError', 'RateLimitError'] },
  { title: '② 错误分类', subtitle: '四类错误', section: '§9.3', detail: '<strong>可重试</strong>（429 Rate Limit / 503 过载）→ 指数退避重试；<strong>上下文过长</strong>（400 + "too long"）→ 触发压缩；<strong>认证失败</strong>（401/403）→ 凭据轮换；<strong>致命</strong>（其他）→ 通知用户。', funcs: ['is_retryable()', 'is_context_too_long()', 'is_auth_error()'] },
  { title: '③ 凭据轮换', subtitle: 'CredentialPool failover', section: '§9.4', detail: 'CredentialPool 维护多个 API key。当一个 key 遇到 401/429 时，自动切换到下一个可用 key。切换后重试同一请求，对调用方透明。支持跨提供商 fallback（如 OpenAI→Anthropic）。', funcs: ['_credential_pool.rotate()', 'fallback_model', 'smart_model_routing'] },
  { title: '④ 路由降级', subtitle: 'strong → cheap 模型降级', section: '§9.5', detail: '当主模型连续失败时，自动降级到更便宜/更稳定的模型。smart_model_routing.py 维护 strong/cheap 模型对映射。降级后自动恢复检测——如果 cheap 模型成功，后续请求尝试恢复到 strong 模型。', funcs: ['SmartModelRouting', '_restore_primary_runtime()', 'cheap_model'] },
];

export default function ErrorRoutingTree() {
  return <StageFlow stages={stages} playLabel="播放错误路由" />;
}
