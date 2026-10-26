import React from 'react';
const logo=new URL('./assets/pibo-logo.png',import.meta.url).href;

/** Product identity only; individual bot avatars are intentionally separate. */
export function PiboMark({size=28}){
    return <img className="pibo-mark" src={logo} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
}
export function PiboBrand(){
    return <span className="pibo-brand"><PiboMark/><span>Pibo</span></span>;
}
