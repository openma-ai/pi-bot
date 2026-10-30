export type ModelConnectionErrorReason = 'invalidParams' | 'conflict' | 'capacity' | 'notFound' | 'forbidden';
/** Domain error; transports translate this without coupling Pi to a daemon. */
export class ModelConnectionError extends Error {
    constructor(readonly reason: ModelConnectionErrorReason, message: string) {
        super(message);
        this.name = 'ModelConnectionError';
    }
}
