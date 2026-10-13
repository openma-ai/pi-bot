import type { RpcTransport } from './types.ts';
export class InProcessTransport implements RpcTransport {
    private connection: any;
    constructor(private host: {
        connect(transport?: string): any;
    }) {
        this.connection = host.connect('in-process');
    }
    async refreshAuth() {
        this.connection = this.host.connect('in-process');
    }
    request(frame: any) {
        return this.connection.request(frame);
    }
    listen(receive: (frame: any) => void) {
        return this.connection.attach((frame: any) => {
            receive(frame);
            return true;
        });
    }
    close() {
        this.connection.close();
    }
}
