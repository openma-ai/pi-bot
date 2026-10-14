import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PiBotError } from './core/errors.ts';
const types = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'
};
export function saveAvatar(dataDir: string, mime: keyof typeof types, encoded: string) {
    const bytes = Buffer.from(encoded, 'base64');
    const signature = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!signature || bytes.length > 524288 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, ''))
        throw new PiBotError('invalidParams', '请选择 512 KB 以内的 PNG、JPEG 或 WebP 图片');
    const hash = createHash('sha256').update(bytes).digest('hex'), dir = join(dataDir, 'avatars');
    mkdirSync(dir, {
        recursive: true
    });
    writeFileSync(join(dir, hash + '.' + types[mime]), bytes, {
        mode: 0o600
    });
    return hash;
}
export function avatarFile(dataDir: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash))
        return;
    for (const [mime, extension] of Object.entries(types)) {
        const path = join(dataDir, 'avatars', hash + '.' + extension);
        if (existsSync(path))
            return {
                path, mime
            };
    }
}
