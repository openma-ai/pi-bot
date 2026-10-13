import { PiBotError } from '../core/errors.ts';
import { randomUUID } from 'node:crypto';
import type { CredentialScope, CredentialForm, CredentialPort } from '../../pi/host.ts';
export type { CredentialScope, CredentialForm } from '../../pi/host.ts';
/** Host-only ephemeral broker. Never serialize this object or send submissions
 * through inbox/chat. A production host must authenticate its form endpoint,
 * enforce origin/CSRF checks and bind requests to the logged-in owner. */
export class CredentialBroker implements CredentialPort {
    #requests = new Map<string, CredentialForm>();
    #values = new Map<string, {
        scope: CredentialScope;
        expiresAt: number;
        value: string;
    }>();
    constructor(private now = Date.now, private callbacks?: {
        created?: (form: CredentialForm) => void;
        submitted?: (id: string, scope: CredentialScope) => void;
    }) {
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
            throw new PiBotError('invalidParams', 'Invalid credential request');
        if (this.#requests.size + this.#values.size >= 32)
            throw new PiBotError('capacity', 'Credential capacity reached');
        const form: CredentialForm = {
            requestId: randomUUID(), scope: {
                ...scope
            }, label, expiresAt: this.now() + ttlMs, fields: [{
                    name: 'secret', type: 'password', autocomplete: 'off'
                }]
        };
        this.#requests.set(form.requestId, structuredClone(form));
        this.callbacks?.created?.(form);
        return form;
    }
    restoreForm(form: CredentialForm) {
        if (form.expiresAt > this.now())
            this.#requests.set(form.requestId, structuredClone(form));
    }
    readForm(id: string) {
        this.sweep();
        return this.#requests.get(id);
    }
    /** Called only by the trusted host after authenticating direct user entry. */
    submit(requestId: string, scope: CredentialScope, secret: string): {
        reference: string;
        expiresAt: number;
    } {
        this.sweep();
        const form = this.#requests.get(requestId);
        if (!form || !this.same(form.scope, scope))
            throw new PiBotError('invalidRequest', 'Credential request unavailable');
        if (!secret || secret.length > 16384)
            throw new PiBotError('invalidParams', 'Invalid credential submission');
        this.callbacks?.submitted?.(requestId, scope);
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
            throw new PiBotError('invalidRequest', 'Credential reference unavailable');
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
