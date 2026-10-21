import { Type } from 'typebox';
import { O, optId, empty } from './shared.ts';
import { Id } from '../models.ts';
const scope = {
    botId: Id, groupId: optId, threadId: optId
};
export const FileRefSchema = O({
    id: Id, name: Type.String(), mime: Type.String(), size: Type.Integer({
        minimum: 0, maximum: 8388608
    }), sha256: Type.String(), scope: Type.String()
});
export const fileMethods = {
    'file/begin': {
        params: O({
            ...scope, name: Type.String({
                minLength: 1, maxLength: 120
            }), mime: Type.String({
                maxLength: 120
            }), size: Type.Integer({
                minimum: 0, maximum: 8388608
            })
        }), result: O({
            file: FileRefSchema
        })
    },
    'file/append': {
        params: O({
            ...scope, id: Id, offset: Type.Integer({
                minimum: 0, maximum: 8388608
            }), data: Type.String({
                maxLength: 349528
            })
        }), result: O({
            received: Type.Integer()
        })
    },
    'file/finish': {
        params: O({
            ...scope, id: Id, sha256: Type.Optional(Type.String({
                pattern: '^[a-f0-9]{64}$'
            }))
        }), result: O({
            file: FileRefSchema
        })
    },
    'file/read': {
        params: O({
            ...scope, id: Id, offset: Type.Integer({
                minimum: 0, maximum: 8388608
            })
        }), result: O({
            file: FileRefSchema, data: Type.String()
        })
    },
    'file/cancel': {
        params: O({
            ...scope, id: Id
        }), result: empty
    },
} as const;
