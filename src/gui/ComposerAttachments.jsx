import React,{useRef,useState} from 'react';
import {DropdownMenu} from '@radix-ui/themes';
import {Plus,Paperclip,Image as ImageIcon,X} from 'lucide-react';
export function AttachmentMenu({disabled,onPick}) {
    const file=useRef(),image=useRef();const [open,setOpen]=useState(false);
    return <><DropdownMenu.Root open={open} onOpenChange={setOpen}><DropdownMenu.Trigger><button type="button" className="composer-add" aria-label="添加附件" disabled={disabled}><Plus size={23} aria-hidden="true"/></button></DropdownMenu.Trigger><DropdownMenu.Content side="top" align="start" className="composer-add-menu"><DropdownMenu.Item onSelect={()=>image.current?.click()}><ImageIcon size={18}/>照片</DropdownMenu.Item><DropdownMenu.Item onSelect={()=>file.current?.click()}><Paperclip size={18}/>文件</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root><input ref={file} hidden aria-label="上传聊天附件" type="file" multiple disabled={disabled} onChange={onPick}/><input ref={image} hidden aria-label="上传图片" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={onPick}/></>;
}
export function ComposerAttachments({busy,error,files,onCancel,onRemove}) {
    if(!busy&&!error&&!files.length)return null;
    return <div className="composer-attachments">{busy&&<div className="attachment-progress" role="status">正在上传…<button type="button" className="attachment-cancel" onClick={onCancel}>取消上传</button></div>}{error&&<div className="attachment-error" role="alert">{error}</div>}{!!files.length&&<ul className="composer-attachment-list" aria-label="待发送附件">{files.map(f=><li key={f.id} data-image={!!f.previewUrl}>{f.previewUrl?<img src={f.previewUrl} alt={f.name}/>:<span title={f.name}><Paperclip size={16}/>{f.name}</span>}<button type="button" aria-label={'移除附件 '+f.name} onClick={()=>onRemove(f)}><X size={16} aria-hidden="true"/></button></li>)}</ul>}</div>;
}
export function ComposerFrame({disabled,busy,error,files,onPick,onCancel,onRemove,children}) {
    return <div className="composer-shell"><ComposerAttachments busy={busy} error={error} files={files} onCancel={onCancel} onRemove={onRemove}/><div className="composer"><AttachmentMenu disabled={disabled} onPick={onPick}/>{children}</div></div>;
}
export function releaseAttachmentPreview(file){if(file.previewUrl)URL.revokeObjectURL(file.previewUrl);}
