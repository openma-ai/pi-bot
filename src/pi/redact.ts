/** Secret redaction shared by the plugin layer and hosts. Pure, dependency-free. */
/** Credential entry uses the separate host broker. Also mask recognizable accidental channel secrets. */
export function redactChannelText(text: string): string {
    return text.replace(/\bBearer\s+[^\s;"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/((?:["']?(?:api[_ -]?key|secret|password|authorization)["']?)\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s;,"'}\]]+/gi, '$1[REDACTED]');
}
/** Redact trace payloads and drop model reasoning before persisting diagnostics. */
export function redactTraceValue<T>(value: T): T {
    const redact = (v: any): any => {
        if (typeof v === 'string')
            return v
                .replace(/\bBearer\s+[^\s;"']+/gi, 'Bearer [REDACTED]')
                .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
                .replace(/((?:api[_ -]?key|secret|password|authorization)\s*[:=]\s*)[^\s;,"']+/gi, '$1[REDACTED]');
        if (Array.isArray(v))
            return v.filter(item => item?.type !== 'thinking' && item?.type !== 'reasoning').map(redact);
        if (v && typeof v === 'object')
            return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(thinking|reasoning|reasoning_content)$/i.test(k)).map(([k, item]) => [k, /^(api[_-]?key|secret|password|authorization|credentials)$/i.test(k) ? '[REDACTED]' : redact(item)]));
        return v;
    };
    return redact(value);
}
