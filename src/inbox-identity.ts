export function inboxIds(context: unknown): string[] {
    const ids = new Set<string>();
    for (const message of (context as any)?.messages ?? []) {
        if (message.role !== 'user')
            continue;
        const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text);
        for (const text of texts)
            try {
                const event = JSON.parse(text);
                if (event.type === 'inbox' && typeof event.messageId === 'string')
                    ids.add(event.messageId);
            }
            catch { /* Ledger and ordinary text are not inbox envelopes. */
            }
    }
    return [...ids];
}
