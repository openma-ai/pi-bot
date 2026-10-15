import { avatarVariant } from './presentation.ts';
export const defaultIdentityColors = ['#eb9b36', '#48b39f', '#9a7ce0', '#5a9cd7', '#d26e9c', '#c6c0b6'];
/** Resolve one canonical solid identity color. Never mutate stored avatar data. */
export function identityColor(id = '', avatar?: { color?: string } | null): string {
  const value = avatar?.color;
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (typeof value === 'string' && /^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map(c => c + c).join('').toLowerCase();
  return id ? defaultIdentityColors[avatarVariant(id)] : '#d5d5d5';
}
function luminance(hex: string): number {
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function conversationPalette(kind: string, id = '', avatar?: { color?: string } | null) {
  const background = kind === 'chat' ? identityColor(id, avatar) : '#dededc';
  const foreground = contrastRatio(background, '#111111') >= 4.5 ? '#111111' : contrastRatio(background, '#ffffff') >= 4.5 ? '#ffffff' : '#000000';
  return { background, foreground };
}
/** Keep sender labels readable on the existing dark transcript surface. */
export function senderLabelColor(id = '', avatar?: {color?:string} | null) {
  const color = identityColor(id,avatar);
  if (contrastRatio(color,'#111111') >= 4.5) return color;
  return '#' + [1,3,5].map(i => Math.round((parseInt(color.slice(i,i+2),16)+255)/2).toString(16).padStart(2,'0')).join('');
}
