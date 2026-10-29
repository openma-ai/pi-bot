export type PiLoginState = {
    id: string;
    providerId: string;
    connectionId?: string;
    type: string;
    status: 'pending' | 'complete' | 'failed' | 'cancelled';
    prompt?: Record<string, any>;
    events: Record<string, any>[];
    expiresAt?: number;
    error?: string;
    errorCode?: string;
    starting?: boolean;
    submitting?: boolean;
    uncertain?: boolean;
};
type Request = (path: string, body?: unknown) => Promise<any>;
type Failure = { message?: string; code?: string; status?: number; submitted?: boolean };
const failure = (error: unknown): Failure => error && typeof error === 'object' ? error : {};
const ambiguous = (error: Failure) => error.submitted !== false && (!error.code || ['connectionLost', 'invalidResponse'].includes(error.code));

/** In-memory interaction state only. Credentials and answers are never retained here. */
export function createPiLoginFlow(request: Request, onChange: (state: PiLoginState | undefined) => void) {
    let current: PiLoginState | undefined;
    let epoch = 0, revision = 0, disposed = false;
    let polling: object | undefined;
    let mayBePending = false;
    const publish = (next: PiLoginState | undefined) => { current = next; if (!disposed) onChange(next); };
    const live = (version: number) => !disposed && epoch === version;
    const cancelRemote = async (id: string) => {
        try { await request(`login/${encodeURIComponent(id)}/cancel`, {}); } catch { /* Never retry or reopen login. */ }
    };
    const errorState = (error: unknown, uncertain: boolean) => {
        const problem = failure(error);
        publish({ ...current!, starting: false, submitting: false, uncertain,
            status: uncertain ? 'pending' : 'failed', errorCode: problem.code,
            error: problem.message || '登录操作未完成，请重试' });
    };
    const stop = (notify: boolean) => {
        const previous = current, shouldCancel = mayBePending;
        epoch++; revision++; polling = undefined; mayBePending = false;
        if (notify) publish(undefined); else current = undefined;
        return previous && shouldCancel ? cancelRemote(previous.id) : Promise.resolve();
    };
    return {
        get current() { return current; },
        async begin(provider: string, type: string, connectionId?: string) {
            if (disposed) throw new Error('登录界面已关闭');
            if (current?.status === 'pending' || mayBePending) throw new Error('已有登录正在进行，请完成或取消');
            const version = ++epoch, id = crypto.randomUUID();
            revision++; polling = undefined; mayBePending = true;
            publish({ id, providerId: provider, connectionId, type, status: 'pending', events: [], starting: true, uncertain: false });
            if (!live(version)) return;
            try {
                const result = await request('login', { provider, type, requestId: id, ...(connectionId ? {connectionId} : {}) });
                const actualId = typeof result?.id === 'string' && result.id ? result.id : id;
                if (!live(version)) { await cancelRemote(actualId); return; }
                if (!result?.id) throw Object.assign(new Error('登录响应尚未确认'), { code: 'invalidResponse', submitted: true });
                publish({ ...current!, id: actualId, starting: false });
            } catch (error) {
                if (!live(version)) {
                    // Cancellation may have reached the server before the initial request did.
                    if (ambiguous(failure(error))) await cancelRemote(id);
                    return;
                }
                mayBePending = ambiguous(failure(error));
                errorState(error, mayBePending);
            }
        },
        async poll() {
            if (disposed || current?.status !== 'pending' || current.starting || current.submitting || polling) return;
            const version = epoch, readRevision = revision, marker = {}, id = current.id;
            polling = marker;
            try {
                const next = await request(`login/${encodeURIComponent(id)}`);
                if (!live(version) || readRevision !== revision) return;
                if (next?.id !== id || (current?.connectionId && next.connectionId !== current.connectionId) ||
                    (next?.providerId && next.providerId !== current?.providerId) || !['pending', 'complete', 'failed', 'cancelled'].includes(next?.status))
                    throw Object.assign(new Error('无法读取登录状态，请重新检查'), { code: 'invalidResponse' });
                mayBePending = next.status === 'pending';
                publish({ ...next, providerId: next.providerId ?? current!.providerId, connectionId: next.connectionId ?? current!.connectionId, type: next.type ?? current!.type,
                    events: next.events ?? [], starting: false, submitting: false, uncertain: false });
            } catch (error) {
                if (!live(version) || readRevision !== revision) return;
                const problem = failure(error);
                const terminal = problem.status === 404 || ['loginExpired', 'runtimeChanged', 'nativePolicyDenied'].includes(problem.code || '');
                if (terminal) mayBePending = false;
                errorState(error, !terminal);
            } finally { if (polling === marker) polling = undefined; }
        },
        async answer(promptId: string, value: string) {
            if (disposed || current?.status !== 'pending' || current.prompt?.id !== promptId || current.submitting)
                throw new Error('登录步骤已失效');
            const version = epoch, id = current.id;
            revision++; polling = undefined;
            publish({ ...current, submitting: true, error: undefined, errorCode: undefined });
            if (!live(version)) return;
            try {
                await request(`login/${encodeURIComponent(id)}/input`, { promptId, value });
                if (live(version)) publish({ ...current!, prompt: undefined, submitting: false, uncertain: false, error: undefined, errorCode: undefined });
            } catch (error) {
                if (live(version)) errorState(error, ambiguous(failure(error)));
            }
        },
        cancel() { return stop(!disposed); },
        dispose() {
            if (disposed) return;
            disposed = true;
            void stop(false);
        }
    };
}
