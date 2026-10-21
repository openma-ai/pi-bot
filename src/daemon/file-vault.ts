import { safeImage, type SafeImage } from './image-files.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeSync, readSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, fstatSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PiBotError } from './core/errors.ts';
export const FILE_LIMIT = 8 * 1024 * 1024, FILE_CHUNK = 256 * 1024;
export type FileRef = {
    id: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    scope: string;
    image?: SafeImage;
};
type RecordFile = FileRef & {
    owner: string;
    received: number;
    ready: boolean;
    bound?: boolean;
    created: number;
};
function boundedBytes(fd: number) {
    const out = Buffer.alloc(FILE_LIMIT + 1);
    let offset = 0;
    while (offset < out.length) {
        const n = readSync(fd, out, offset, out.length - offset, null);
        if (!n)
            break;
        offset += n;
    }
    if (offset > FILE_LIMIT)
        throw new PiBotError('invalidParams', 'File grew beyond 8 MiB');
    return out.subarray(0, offset);
}
const fail = (message: string): never => {
    throw new PiBotError('invalidParams', message);
};
export function safeFileName(name: string) {
    if (!name || name.length > 120 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..' || /[\u202a-\u202e\u2066-\u2069]/.test(name))
        fail('Invalid filename');
    return name;
}
export class FileVault {
    readonly root: string;
    constructor(root: string) {
        root = resolve(root);
        mkdirSync(root, {
            recursive: true, mode: 0o700
        });
        if (lstatSync(root).isSymbolicLink())
            fail("File storage cannot use symlinks");
        this.root = realpathSync(root);
    }
    private path(id: string, suffix: string) {
        if (!/^[a-f0-9-]{36}$/.test(id))
            fail('Invalid file ID');
        return join(this.root, id + suffix);
    }
    private load(id: string): RecordFile {
        try {
            return JSON.parse(readFileSync(this.path(id, '.json'), 'utf8'));
        }
        catch {
            throw new PiBotError('notFound', 'File unavailable');
        }
    }
    private save(f: RecordFile) {
        const tmp = this.path(f.id, '.json.tmp');
        writeFileSync(tmp, JSON.stringify(f), {
            mode: 0o600, flag: 'w'
        });
        renameSync(tmp, this.path(f.id, '.json'));
    }
    private check(owner: string, scope: string, id: string) {
        const f = this.load(id);
        if (f.owner !== owner || f.scope !== scope)
            throw new PiBotError('forbidden', 'File belongs to another owner or conversation');
        return f;
    }
    owns(owner: string, id: string) {
        try {
            return this.load(id).owner === owner;
        }
        catch {
            return false;
        }
    }
    ref(f: RecordFile): FileRef {
        const { id, name, mime, size, sha256, scope, image } = f;
        return {
            id, name, mime, size, sha256, scope, ...(image ? {
                image
            } : {})
        };
    }
    begin(owner: string, scope: string, name: string, mime: string, size: number) {
        safeFileName(name);
        if (!Number.isInteger(size) || size < 0 || size > FILE_LIMIT)
            fail('File limit is 8 MiB');
        if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 120)
            mime = 'application/octet-stream';
        const records = readdirSync(this.root).filter(x => x.endsWith('.json')).map(x => this.load(x.slice(0, -5))).filter(f => {
            if (!f.bound && f.created < Date.now() - 24 * 60 * 60 * 1000) {
                this.remove(f.owner, f.scope, f.id);
                return false;
            }
            return true;
        });
        if (records.length >= 512 || records.reduce((n, f) => n + f.size, 0) + size > 256 * 1024 * 1024)
            throw new PiBotError('capacity', 'File storage quota reached (256 MiB / 512 files)');
        const f: RecordFile = {
            id: randomUUID(), name, mime, size, sha256: '', scope, owner, received: 0, ready: false, created: Date.now()
        };
        writeFileSync(this.path(f.id, '.bin'), Buffer.alloc(0), {
            flag: 'wx', mode: 0o600
        });
        this.save(f);
        return this.ref(f);
    }
    append(owner: string, scope: string, id: string, offset: number, data: string) {
        const f = this.check(owner, scope, id);
        if (f.ready)
            fail('File already finalized');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.toString('base64') !== data || bytes.length > FILE_CHUNK || offset < 0 || offset + bytes.length > f.size)
            fail('Invalid file chunk');
        const fd = openSync(this.path(id, '.bin'), constants.O_RDWR | constants.O_NOFOLLOW);
        try {
            if (offset < f.received) {
                const old = Buffer.alloc(bytes.length);
                readSync(fd, old, 0, old.length, offset);
                if (offset + bytes.length > f.received || !old.equals(bytes))
                    fail('Chunk conflict');
                return {
                    received: f.received
                };
            }
            if (offset !== f.received)
                fail('Out-of-order chunk');
            writeSync(fd, bytes, 0, bytes.length, offset);
            f.received += bytes.length;
            this.save(f);
            return {
                received: f.received
            };
        }
        finally {
            closeSync(fd);
        }
    }
    finish(owner: string, scope: string, id: string, sha256?: string) {
        const f = this.check(owner, scope, id);
        if (f.received !== f.size)
            fail('File incomplete');
        const bytes = this.bytes(f);
        const image = safeImage(bytes, f.mime);
        if (image) {
            f.image = image;
            f.mime = image.mime;
        }
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (sha256 && sha256 !== hash)
            fail('File checksum mismatch');
        f.sha256 = hash;
        f.ready = true;
        this.save(f);
        return this.ref(f);
    }
    private bytes(f: RecordFile) {
        const fd = openSync(this.path(f.id, '.bin'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const s = fstatSync(fd);
            if (!s.isFile() || s.size > FILE_LIMIT || s.size !== f.received || s.nlink !== 1)
                fail('Invalid stored file');
            return boundedBytes(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    metadata(owner: string, scope: string, id: string) {
        const f = this.check(owner, scope, id);
        if (!f.ready)
            fail('File incomplete');
        return this.ref(f);
    }
    read(owner: string, scope: string, id: string, offset: number) {
        const f = this.check(owner, scope, id);
        if (!f.ready || offset < 0 || offset > f.size)
            fail('Invalid download');
        return {
            file: this.ref(f), data: this.bytes(f).subarray(offset, offset + FILE_CHUNK).toString('base64')
        };
    }
    remove(owner: string, scope: string, id: string) {
        const f = this.check(owner, scope, id);
        if (f.bound)
            fail('Attached files are retained');
        unlinkSync(this.path(id, '.bin'));
        unlinkSync(this.path(id, '.json'));
        return {};
    }
    bind(owner: string, scope: string, ids: string[]) {
        for (const id of ids) {
            const f = this.check(owner, scope, id);
            if (!f.ready)
                fail("File incomplete");
            f.bound = true;
            this.save(f);
        }
    }
    imageInputs(owner: string, scope: string, ids: string[]) {
        return ids.flatMap(id => {
            const f = this.check(owner, scope, id);
            if (!f.ready || !f.image)
                return [];
            const bytes = this.bytes(f), image = safeImage(bytes, f.mime);
            if (!image || createHash('sha256').update(bytes).digest('hex') !== f.sha256)
                fail('Image integrity check failed');
            return [{
                    type: 'image' as const, data: bytes.toString('base64'), mimeType: image!.mime
                }];
        });
    }
    context(owner: string, scope: string, ids: string[]) {
        return ids.map(id => {
            const file = this.metadata(owner, scope, id);
            return {
                ...file, path: this.path(id, '.bin'), untrusted: true
            };
        });
    }
    workspace(owner: string, scope: string) {
        const tag = createHash('sha256').update(owner + '\0' + scope).digest('hex');
        const dir = join(this.root, 'output-' + tag);
        mkdirSync(dir, {
            recursive: true, mode: 0o700
        });
        if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir)
            fail('Unsafe output directory');
        return dir;
    }
    publish(owner: string, scope: string, name: string, mime: string) {
        safeFileName(name);
        const path = join(this.workspace(owner, scope), name);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
            const s = fstatSync(fd);
            if (!s.isFile() || s.nlink !== 1 || s.size > FILE_LIMIT)
                fail('Only a regular output file up to 8 MiB can be published');
            bytes = boundedBytes(fd);
            if (bytes.length > FILE_LIMIT)
                fail('File too large');
        }
        finally {
            closeSync(fd);
        }
        const file = this.begin(owner, scope, name, mime, bytes.length);
        for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK)
            this.append(owner, scope, file.id, offset, bytes.subarray(offset, offset + FILE_CHUNK).toString('base64'));
        return this.finish(owner, scope, file.id);
    }
}
