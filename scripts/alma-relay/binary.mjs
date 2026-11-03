// Protocol-2 binary frames (docs/PROTOCOL.md in yetone/alma-relay).
//
//   [kind: u8][idLen: u8][id: UTF-8][payload]
//
// Kept local and tiny so the agent has no runtime dependency on the relay
// repository.

export const BIN = Object.freeze({
    HCHUNK: 1, // agent -> relay: response body bytes
    HBODY: 2, // relay -> agent: request body bytes
    WBIN: 3, // both: binary WebSocket message
    WTEXT: 4, // both: text WebSocket message, UTF-8
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBinary(kind, id, payload) {
    const idBytes = encoder.encode(String(id));
    if (idBytes.length > 255) throw new Error('frame id too long');
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
    const frame = new Uint8Array(2 + idBytes.length + bytes.length);
    frame[0] = kind;
    frame[1] = idBytes.length;
    frame.set(idBytes, 2);
    frame.set(bytes, 2 + idBytes.length);
    return frame;
}

/** -> {kind, id, data}, or null when the frame is malformed. */
export function decodeBinary(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return null;
    return {
        kind: bytes[0],
        id: decoder.decode(bytes.subarray(2, 2 + bytes[1])),
        data: bytes.subarray(2 + bytes[1]),
    };
}

/** The lower of our offer and the relay's answer; an absent answer means 1. */
export function negotiateProtocol(offered, answered) {
    return Number(offered) >= 2 && Number(answered) >= 2 ? 2 : 1;
}
