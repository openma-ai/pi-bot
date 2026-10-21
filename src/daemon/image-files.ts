import { imageSize } from 'image-size';
import { PiBotError } from './core/errors.ts';
export const IMAGE_LIMIT = 5 * 1024 * 1024, IMAGE_PIXELS = 16 * 1024 * 1024;
export type SafeImage = {
    mime: 'image/png' | 'image/jpeg' | 'image/webp';
    width: number;
    height: number;
};
const allowed = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]);
function invalid(text: string): never {
    throw new PiBotError('invalidParams', text);
}
/** Header/dimension validation, not an image decoder. Render only in an inert img. */
export function safeImage(bytes: Uint8Array, mime: string): SafeImage | undefined {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg' : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : undefined;
    const expects = [...allowed.values()].includes(mime);
    if (!signature) {
        if (expects)
            invalid('图片签名与声明的类型不符；支持 PNG、JPEG、WebP');
        return undefined;
    }
    if (mime !== 'application/octet-stream' && mime !== signature) {
        if (mime.startsWith('image/'))
            invalid('图片 MIME 与文件内容不符');
        return undefined;
    }
    if (b.length > IMAGE_LIMIT)
        invalid('图片最多 5 MiB');
    let info;
    try {
        info = imageSize(b);
    }
    catch {
        invalid('图片头或尺寸无效');
    }
    if (!info || allowed.get(info.type ?? '') !== signature || !info.width || !info.height || info.width > 8192 || info.height > 8192 || info.width * info.height > IMAGE_PIXELS)
        invalid('图片最大边长 8192 像素，总像素最多 16 MP');
    // Keep frame count bounded: animated PNG/WebP remain ordinary files only when
    // uploaded as a non-image type; raster image mode deliberately rejects them.
    if (signature === 'image/png') {
        let offset = 8, ended = false;
        while (offset + 12 <= b.length) {
            const length = b.readUInt32BE(offset), type = b.toString('ascii', offset + 4, offset + 8);
            if (length > b.length - offset - 12)
                invalid('PNG 数据不完整');
            if (type === 'acTL')
                invalid('暂不支持动画 PNG');
            offset += length + 12;
            if (type === 'IEND') {
                ended = true;
                break;
            }
        }
        if (!ended)
            invalid('PNG 数据不完整');
    }
    if (signature === 'image/webp') {
        if (b.length < 20 || b.readUInt32LE(4) + 8 !== b.length)
            invalid('WebP 数据不完整');
        for (let offset = 12; offset + 8 <= b.length;) {
            const type = b.toString('ascii', offset, offset + 4), length = b.readUInt32LE(offset + 4);
            if (length > b.length - offset - 8)
                invalid('WebP 数据不完整');
            if (type === 'ANIM' || type === 'ANMF')
                invalid('暂不支持动画 WebP');
            offset += 8 + length + (length % 2);
        }
    }
    if (signature === 'image/jpeg' && (b.length < 4 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217))
        invalid('JPEG 数据不完整');
    return {
        mime: signature as SafeImage['mime'], width: info.width, height: info.height
    };
}
