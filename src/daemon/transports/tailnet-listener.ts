import { tailnetBindAddress, type TailnetListener } from './tailnet-gateway.ts';
/** Parse before daemon creation. This never configures Tailscale Serve itself. */
export function tailnetListenerOptions(args: readonly string[]): TailnetListener | undefined {
    const listenFlag = '--tailnet-listen', forwardFlag = '--tailnet-serve-loopback';
    if (args.filter(s => s === listenFlag).length > 1 || args.filter(s => s === forwardFlag).length > 1 || args.some(s => s.startsWith(forwardFlag + '=')))
        throw Error('Specify Tailnet listener flags once; --tailnet-serve-loopback takes no value');
    const i = args.indexOf(listenFlag), forward = args.includes(forwardFlag);
    if (i < 0) {
        if (forward)
            throw Error('--tailnet-serve-loopback requires --tailnet-listen 100.x.x.x:port');
        return undefined;
    }
    const match = /^(100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):([0-9]{1,5})$/.exec(args[i + 1] ?? '');
    if (!match || String(Number(match[2])) !== match[2])
        throw Error('Use --tailnet-listen 100.x.x.x:port');
    const options: TailnetListener = {
        host: match[1]!, port: Number(match[2]), ...(forward ? {
            listenMode: 'serve-loopback'
        } : {})
    };
    tailnetBindAddress(options);
    return options;
}
