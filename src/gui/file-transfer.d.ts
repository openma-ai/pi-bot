import type { PiBotClient } from '../sdk/client.ts';
import type { FileAttachment } from '../pi/types.ts';
export type FileScope = {
    botId: string;
    groupId?: string;
    threadId?: string;
};
export const FILE_LIMIT: number, FILE_CHUNK: number;
export function encodeBytes(bytes: Uint8Array): string;
export function decodeBytes(data: string): Uint8Array<ArrayBuffer>;
export function hashBytes(bytes: Uint8Array): Promise<string>;
export function uploadFile(api: PiBotClient, scope: FileScope, file: File, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<FileAttachment>;
export function downloadFile(api: PiBotClient, scope: FileScope, file: FileAttachment, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>>;
