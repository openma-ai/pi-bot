export const FILE_LIMIT = 8 * 1024 * 1024, FILE_CHUNK = 256 * 1024;
export function encodeBytes(bytes) {
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192)
        value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(value);
}
export function decodeBytes(data) {
    return Uint8Array.from(atob(data), c => c.charCodeAt(0));
}
export async function hashBytes(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function uploadFile(api, scope, file, signal, onProgress = () => {
}) {
    signal?.throwIfAborted();
    if (file.size > FILE_LIMIT)
        throw Error('每个文件最多 8 MiB');
    let id;
    try {
        const begun = await api.file.begin({
            ...scope, name: file.name, mime: file.type || 'application/octet-stream', size: file.size
        });
        id = begun.file.id;
        const bytes = new Uint8Array(await file.arrayBuffer());
        for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK) {
            signal?.throwIfAborted();
            await api.file.append({
                ...scope, id, offset, data: encodeBytes(bytes.subarray(offset, offset + FILE_CHUNK))
            });
            onProgress(Math.min(offset + FILE_CHUNK, bytes.length));
        }
        signal?.throwIfAborted();
        const result = await api.file.finish({
            ...scope, id, sha256: await hashBytes(bytes)
        });
        signal?.throwIfAborted();
        return result.file;
    }
    catch (e) {
        if (id)
            await api.file.cancel({
                ...scope, id
            }).catch(() => {
            });
        throw e;
    }
}
export async function downloadFile(api, scope, file, signal, onProgress = () => {
}) {
    if (file.size > FILE_LIMIT)
        throw Error('文件超出 8 MiB 限制');
    const bytes = new Uint8Array(file.size);
    let first = true;
    for (let offset = 0; first || offset < file.size;) {
        first = false;
        signal?.throwIfAborted();
        const part = await api.file.read({
            ...scope, id: file.id, offset
        });
        if (part.file.sha256 !== file.sha256 || part.file.size !== file.size)
            throw Error('文件元数据已变化');
        const data = decodeBytes(part.data);
        if (!file.size && !data.length)
            break;
        if (!data.length || offset + data.length > bytes.length)
            throw Error('文件响应无效');
        bytes.set(data, offset);
        offset += data.length;
        onProgress(offset);
    }
    if (await hashBytes(bytes) !== file.sha256)
        throw Error('文件校验失败，请重新下载');
    signal?.throwIfAborted();
    return bytes;
}
