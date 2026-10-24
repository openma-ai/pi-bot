import { Type, type Static } from 'typebox';
const path = Type.String({
    minLength: 1, maxLength: 2048, pattern: '^[^\\u0000-\\u001f]+$'
});
const port = Type.Integer({
    minimum: 1, maximum: 65535
});
const identity = {
    id: Type.Optional(Type.String({
        minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$'
    })), name: Type.Optional(Type.String({
        minLength: 1, maxLength: 100, pattern: '\\S'
    }))
};
export const RuntimeProfileSchema = Type.Union([
    Type.Object({...identity, mode:Type.Literal("direct"),url:Type.String({maxLength:2048}),dataDir:Type.Optional(Type.String({maxLength:0}))},{additionalProperties:false}),
    Type.Object({
        ...identity, mode: Type.Literal('tailnet'), host: Type.String({
            pattern: '^100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.(?:[0-9]{1,3})\\.(?:[0-9]{1,3})$'
        }), serverPort: port, dataDir: Type.Optional(Type.String({
            maxLength: 0
        })), embeddedTailscale: Type.Optional(Type.Boolean())
    }, {
        additionalProperties: false
    }),
    Type.Object({
        ...identity, mode: Type.Literal('local'), dataDir: path, agentDir: Type.Optional(path)
    }, {
        additionalProperties: false
    }),
    Type.Object({
        ...identity, embeddedTailscale: Type.Optional(Type.Boolean()), mode: Type.Literal('ssh'), host: Type.String({
            minLength: 1, maxLength: 255, pattern: '^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$'
        }), hostKey: Type.Optional(Type.String({
            minLength: 1, maxLength: 4096
        })), projectDir: path, dataDir: path, node: Type.Optional(path), sshPort: Type.Optional(port), configFile: Type.Optional(path), serverPort: Type.Integer({
            minimum: 0, maximum: 65535
        })
    }, {
        additionalProperties: false
    })
]);
export type RuntimeProfile = Static<typeof RuntimeProfileSchema>;
export const RuntimeStatusSchema = Type.Object({
    profiles: Type.Array(RuntimeProfileSchema, {
        minItems: 0, maxItems: 32
    }),
    active: Type.Union([Type.Object({
            id: Type.String(), profileId: Type.String(), mode: Type.Union([Type.Literal('local'), Type.Literal('ssh'), Type.Literal('tailnet'),Type.Literal('direct')]), baseUrl: Type.String(), profile: Type.Optional(RuntimeProfileSchema), scope: Type.String(), label: Type.String()
        }), Type.Null()]),
    tailscaleNodeState: Type.Optional(Type.Union([Type.Literal("unavailable"), Type.Literal("notPrepared"), Type.Literal("prepared"), Type.Literal("dialed"), Type.Literal("stopped")])),
    embeddedTailscaleAvailable: Type.Optional(Type.Boolean()),
    remoteOnly: Type.Optional(Type.Boolean()),
    credentialStorage: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("keychain"), Type.Literal("system")])),
    connecting: Type.Boolean()
});
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
/** Local connection control; bot operations always use the ordinary PiBotClient. */
export const clientRuntimeMethods = {
    'runtime/status': {
        params: Type.Object({}, {
            additionalProperties: false
        }), result: RuntimeStatusSchema
    },
    'runtime/connect': {
        params: Type.Object({
            profile: RuntimeProfileSchema
        }, {
            additionalProperties: false
        }), result: RuntimeStatusSchema
    },
    'runtime/configure': {
        params: Type.Object({
            profile: RuntimeProfileSchema
        }, {
            additionalProperties: false
        }), result: RuntimeStatusSchema
    },
    'runtime/remove': {
        params: Type.Object({
            id: Type.String({
                minLength: 1, maxLength: 64
            })
        }, {
            additionalProperties: false
        }), result: RuntimeStatusSchema
    },
    'runtime/disconnect': {
        params: Type.Object({}, {
            additionalProperties: false
        }), result: RuntimeStatusSchema
    }
} as const;
