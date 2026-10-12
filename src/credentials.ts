import { randomUUID } from 'node:crypto';
export interface CredentialScope {
    botId: string;
    taskId: string;
    tool: string;
}
export interface CredentialForm {
    requestId: string;
    scope: CredentialScope;
    label: string;
    expiresAt: number;
    fields: {
        name: 'secret';
        type: 'password';
        autocomplete: 'off';
    }[];
}
/** Host-only ephemeral broker. Never serialize this object or send submissions
 * through inbox/chat. A production host must authenticate its form endpoint,
 * enforce origin/CSRF checks and bind requests to the logged-in owner. */
export class CredentialBroker {
    #requests = new Map<string, CredentialForm>();
    #values = new Map<string, {
        scope: CredentialScope;
        expiresAt: number;
        value: string;
    }>();
    constructor(private now = Date.now) {
    }
    private same(a: CredentialScope, b: CredentialScope) {
        return a.botId === b.botId && a.taskId === b.taskId && a.tool === b.tool;
    }
    private sweep() {
        for (const [id, form] of this.#requests)
            if (form.expiresAt <= this.now())
                this.#requests.delete(id);
        for (const [id, entry] of this.#values)
            if (entry.expiresAt <= this.now())
                this.#values.delete(id);
    }
    request(scope: CredentialScope, label: string, ttlMs = 300000): CredentialForm {
        this.sweep();
        if (!scope.botId || !scope.taskId || !scope.tool || label.length > 120 || ttlMs < 1 || ttlMs > 300000 || !Number.isFinite(ttlMs))
            throw Error('Invalid credential request');
        if (this.#requests.size + this.#values.size >= 32)
            throw Error('Credential capacity reached');
        const form: CredentialForm = {
            requestId: randomUUID(), scope: {
                ...scope
            }, label, expiresAt: this.now() + ttlMs, fields: [{
                    name: 'secret', type: 'password', autocomplete: 'off'
                }]
        };
        this.#requests.set(form.requestId, structuredClone(form));
        return form;
    }
    /** Called only by the trusted host after authenticating direct user entry. */
    submit(requestId: string, scope: CredentialScope, secret: string): {
        reference: string;
        expiresAt: number;
    } {
        this.sweep();
        const form = this.#requests.get(requestId);
        if (!form || !this.same(form.scope, scope))
            throw Error('Credential request unavailable');
        if (!secret || secret.length > 16384)
            throw Error('Invalid credential submission');
        this.#requests.delete(requestId);
        const reference = randomUUID();
        this.#values.set(reference, {
            scope: {
                ...scope
            }, expiresAt: form.expiresAt, value: secret
        });
        return {
            reference, expiresAt: form.expiresAt
        };
    }
    /** Host tool consumes a reference once. No result/error leaves this boundary:
     * callers receive a fixed status so secrets cannot reach job logs/results. */
    async use(reference: string, scope: CredentialScope, execute: (secret: string) => Promise<void>): Promise<{
        state: 'completed' | 'failed';
    }> {
        this.sweep();
        const entry = this.#values.get(reference);
        if (!entry || !this.same(entry.scope, scope))
            throw Error('Credential reference unavailable');
        this.#values.delete(reference);
        try {
            await execute(entry.value);
            return {
                state: 'completed'
            };
        }
        catch {
            return {
                state: 'failed'
            };
        }
        finally {
            entry.value = '';
        }
    }
    revoke(id: string) {
        this.#requests.delete(id);
        this.#values.delete(id);
    }
    close() {
        this.#requests.clear();
        for (const entry of this.#values.values())
            entry.value = '';
        this.#values.clear();
    }
    toJSON() {
        return {
            credentials: '[REDACTED]'
        };
    }
}
