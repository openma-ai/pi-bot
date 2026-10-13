import { Type } from 'typebox';
export function literals<const T extends readonly string[]>(values: T) {
    return Type.Enum(Object.fromEntries(values.map(x => [x, x])) as {
        [K in T[number]]: K;
    });
}
