export function isComposerSubmit(event:{key:string;shiftKey?:boolean;isComposing?:boolean;keyCode?:number;nativeEvent?:{isComposing?:boolean;keyCode?:number}}){
    return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!event.nativeEvent?.isComposing&&event.keyCode!==229&&event.nativeEvent?.keyCode!==229;
}
/** Follow the CSS viewport-dependent ceiling; overflowing multi-line text stays scrollable. */
export function resizeComposerTextarea(input:HTMLTextAreaElement|null,readMax=(el:HTMLTextAreaElement)=>getComputedStyle(el).maxHeight){
    if(!input)return;
    const limit=Math.max(44,Math.min(160,parseFloat(readMax(input))||160));
    input.style.height='auto';const needed=input.scrollHeight;
    input.style.height=`${Math.min(needed,limit)}px`;
    input.style.overflowY=needed>limit?'auto':'hidden';
}
