export interface RpcTransport {
    request(frame: unknown): Promise<any>;
    refreshAuth?(): Promise<void>;
    setConnection?(id: string): void;
    listen?(receive: (frame: any) => void, disconnected?: (error?: unknown) => void): () => void;
    close(): void;
}
