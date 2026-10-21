import {ImageAttachment} from './ImageAttachment.jsx';
import React, { useState, useRef, useEffect } from 'react';
import { downloadFile, encodeBytes } from './file-transfer.js';
export function FileCards({ files = [], api, scope,imageInputStatus }) {
    const [busy, setBusy] = useState(''), [error, setError] = useState(''), [progress, setProgress] = useState(0);
    const cancel = useRef();
    useEffect(() => () => cancel.current?.abort(), []);
    async function save(file) {
        setBusy(file.id);
        setError('');
        setProgress(0);
        cancel.current = new AbortController();
        try {
            const bytes = await downloadFile(api, scope, file, cancel.current.signal, setProgress);
            if (globalThis.window?.__PIBOT_NATIVE__) {
                await globalThis.window?.__PIBOT_NATIVE__.call('file_export', {
                    name: file.name, data: encodeBytes(bytes)
                });
            }
            else {
                const blob = new Blob([bytes], {
                    type: 'application/octet-stream'
                }), url = URL.createObjectURL(blob), a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            }
        }
        catch (e) {
            if (e.name !== 'AbortError')
                setError(String(e.message || e));
        }
        finally {
            setBusy('');
        }
    }
    return <div className="file-cards">{files.map(f => <div className="file-card" key={f.id}>{f.image && <ImageAttachment file={f} api={api} scope={scope} onSave={()=>save(f)}/>}<span>{f.image?'图片':'📄'} {f.name}</span>{f.image&&imageInputStatus==='unsupported'&&<span role="status">当前模型不支持图片：未发送图像内容。请切换视觉模型后重新发送。</span>}{f.image&&imageInputStatus==='attached'&&<small>图像内容已附加到本轮输入</small>}{!f.image&&f.mime.startsWith('image/')&&<small>此附件未提供安全图片信息，按普通文件保留，不自动预览或识图。</small>}<small>{(f.size / 1024).toFixed(1)} KiB · {f.mime}</small><button disabled={!api || !!busy} onClick={() => save(f)}>{busy === f.id ? `下载 ${Math.round(progress / Math.max(1, f.size) * 100)}%` : globalThis.window?.__PIBOT_NATIVE__ ? '保存 / 分享' : '下载文件'}</button>{busy === f.id && <button onClick={() => cancel.current?.abort()}>取消下载</button>}</div>)}{error && <span role="alert">{error}</span>}</div>;
}
