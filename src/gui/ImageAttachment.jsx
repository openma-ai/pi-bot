import React, { useEffect, useRef, useState } from 'react';
import { Dialog, Button, Text, Flex } from '@radix-ui/themes';
import { downloadFile } from './file-transfer.js';
export function ImageAttachment({ file, api, scope, onSave }) {
    const [url, setUrl] = useState(''), [error, setError] = useState(''), [open, setOpen] = useState(false), [visible, setVisible] = useState(false);
    const frame = useRef(), trigger = useRef();
    const shouldLoad = visible || open;
    useEffect(() => {
        if (!frame.current)
            return;
        const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), {
            rootMargin: '120px'
        });
        observer.observe(frame.current);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        if (!shouldLoad || !api)
            return;
        const controller = new AbortController();
        let disposed = false, objectUrl;
        const image = file.image;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(image?.mime) || file.size > 5 * 1024 * 1024)
            return;
        setError('');
        void downloadFile(api, scope, file, controller.signal).then(bytes => {
            if (disposed)
                return;
            objectUrl = URL.createObjectURL(new Blob([bytes], {
                type: image.mime
            }));
            setUrl(objectUrl);
        }).catch(e => {
            if (!disposed && e.name !== 'AbortError')
                setError('图片预览失败，仍可尝试下载原文件');
        });
        return () => {
            disposed = true;
            controller.abort();
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
            setUrl('');
        };
    }, [api, file.id, file.sha256, shouldLoad, JSON.stringify(scope)]);
    return <div ref={frame} className="image-attachment"><Dialog.Root open={open} onOpenChange={next => {
        setOpen(next);
        if (!next)
            requestAnimationFrame(() => trigger.current?.focus());
    }}><Dialog.Trigger><button ref={trigger} className="image-thumbnail" aria-label={`预览图片 ${file.name}`} disabled={!url}>{url ? <img src={url} alt={file.name} width={file.image.width} height={file.image.height} onError={() => {
        setError('图片无法解码，请下载原文件检查');
        setUrl('');
    }}/> : <span>{error || '图片 · 滚动到此处后加载'}</span>}</button></Dialog.Trigger>{open && <Dialog.Content className="image-preview-dialog"><Dialog.Title>{file.name}</Dialog.Title><Dialog.Description>{file.image.width} × {file.image.height} · 原图预览</Dialog.Description>{url && <img className="image-preview" src={url} alt={file.name}/>}<Flex gap="3" justify="end"><Button variant="soft" onClick={onSave}>{globalThis.window?.__PIBOT_NATIVE__ ? '保存 / 分享原图' : '下载原图'}</Button><Dialog.Close><Button>关闭</Button></Dialog.Close></Flex></Dialog.Content>}</Dialog.Root>{error && <Text color="amber" size="1" role="status">{error}</Text>}</div>;
}
