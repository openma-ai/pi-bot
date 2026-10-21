import React, { useState, useRef, useEffect } from 'react';
import { downloadFile, encodeBytes } from './file-transfer.js';
export function FileCards({ files = [], api, scope }) {
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
    return <div className="file-cards">{files.map(f => <div className="file-card" key={f.id}><span>📄 {f.name}</span><small>{(f.size / 1024).toFixed(1)} KiB · {f.mime}</small><button disabled={!api || !!busy} onClick={() => save(f)}>{busy === f.id ? `下载 ${Math.round(progress / Math.max(1, f.size) * 100)}%` : globalThis.window?.__PIBOT_NATIVE__ ? '保存 / 分享' : '下载文件'}</button>{busy === f.id && <button onClick={() => cancel.current?.abort()}>取消下载</button>}</div>)}{error && <span role="alert">{error}</span>}</div>;
}
