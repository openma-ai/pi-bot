import { ProviderRequestGuardError } from '../../pi/host.ts';
import type { ErrorReason } from '../../sdk/protocol/errors.ts';
import { redactTraceValue } from '../../pi/redact.ts';
export class PiBotError extends Error {
    constructor(readonly reason: ErrorReason, message: string, readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'PiBotError';
    }
}
export function classifyError(error: unknown): PiBotError {
    if (error instanceof PiBotError)
        return error;
    if (error instanceof ProviderRequestGuardError)
        return new PiBotError(error.reason, error.message);
    const m = error instanceof Error ? error.message : '';
    const rules: [
        RegExp,
        ErrorReason
    ][] = [[/Idempotency|already answered|snapshot changed|Evidence changed|superseded$/i, 'conflict'], [/Unknown|Missing native inbox/i, 'notFound'], [/capacity|Concurrent job budget/i, 'capacity'], [/cancelled; no new|superseded or cancelled/i, 'taskCancelled'], [/budget|额度|work budget/i, 'budgetExhausted'], [/Permission|owner mismatch|channel mismatch|不属于|继承|仓库|allowlisted|outside scope|Only host user/i, 'forbidden'], [/requires evidence|review note|explicit review|已有执行痕迹|must be uncertain|need review/i, 'reviewRequired'], [/Pi .*配置|Pi .*认证|\/login|\/model/i, 'setupRequired'], [/closing/i, 'shuttingDown'], [/Invalid|too large|exceeds|key required|请选择|请输入|必填|@/i, 'invalidParams'], [/cancelled|completed|dry-run|proposal|memory/i, 'invalidRequest']];
    const reason = rules.find(([r]) => r.test(m))?.[1] ?? 'internal';
    return new PiBotError(reason, reason === 'internal' ? 'Internal operation failed' : m);
}
export function toRpcError(error: unknown) {
    const e = classifyError(error);
    const code = e.reason === 'invalidParams' ? -32602 : ['invalidRequest', 'notInitialized', 'alreadyInitialized', 'shuttingDown', 'threadArchived'].includes(e.reason) ? -32600 : ['capacity', 'budgetExhausted', 'overloaded'].includes(e.reason) ? -32001 : e.reason === 'internal' ? -32603 : -32002;
    return {
        code: Number(e.details?.rpcCode ?? code), message: e.message, data: {
            reason: e.reason, retryable: ['capacity', 'overloaded', 'shuttingDown'].includes(e.reason), ...(e.details ? {
                details: redactTraceValue(e.details)
            } : {})
        }
    };
}
