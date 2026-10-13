import { resolve } from 'node:path';
import { ChannelMessageReader } from '../daemon/runtime/channel-messages.ts';
const args = new Map<string, string>();
const switches = new Set<string>();
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--changes') {
        switches.add(flag);
        continue;
    }
    if (!['--db', '--channel', '--conversation', '--thread', '--bot', '--direction', '--after', '--limit'].includes(flag) || !process.argv[i + 1] || args.has(flag))
        throw Error('Invalid message-query arguments');
    args.set(flag, process.argv[++i]);
}
if (!args.get('--db') || !args.get('--channel'))
    throw Error('Usage: messages:query --db DATABASE --channel CHANNEL [--changes] [--after CURSOR] [--limit 100] [--conversation ID] [--thread ID] [--bot ID] [--direction inbound|outbound]');
const direction = args.get('--direction');
if (direction && !['inbound', 'outbound'].includes(direction))
    throw Error('Invalid direction');
const reader = new ChannelMessageReader(resolve(args.get('--db')!), {
    channels: [args.get('--channel')!], ...(args.get('--bot') ? {
        botIds: [args.get('--bot')!]
    } : {})
});
try {
    const query = {
        channelId: args.get('--channel')!, conversationId: args.get('--conversation'), threadId: args.get('--thread'), botId: args.get('--bot'), direction: direction as 'inbound' | 'outbound' | undefined, after: args.get('--after'), limit: args.has('--limit') ? Number(args.get('--limit')) : undefined
    };
    console.log(JSON.stringify(switches.has('--changes') ? reader.changes(query) : reader.list(query)));
}
finally {
    reader.close();
}
