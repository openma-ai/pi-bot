import { Type, type Static } from 'typebox';
export const reasons = ['invalidParams', 'notFound', 'conflict', 'forbidden', 'capacity', 'budgetExhausted', 'taskCancelled', 'invalidRequest', 'reviewRequired', 'setupRequired', 'shuttingDown', 'internal', 'overloaded', 'notInitialized', 'alreadyInitialized', 'cursorExpired', 'threadArchived'] as const;
import { literals } from './literals.ts';
export const ErrorReasonSchema = literals(reasons);
export type ErrorReason = Static<typeof ErrorReasonSchema>;
export const ErrorDataSchema = Type.Object({
    reason: ErrorReasonSchema, retryable: Type.Boolean(), details: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
});
export type ErrorData = Static<typeof ErrorDataSchema>;
