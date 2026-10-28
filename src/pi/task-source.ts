/** Fixed diagnostic; never embeds inbox contents or another task's identifiers. */
export class TaskSourceRequiredError extends Error {
    readonly code = 'taskSourceRequired';
    readonly field = 'source_message_id';
    constructor() {
        super('Ambiguous task source; supply source_message_id for the intended inbox task at the outer tool call. A source inside codemode JavaScript does not bind its execution.');
    }
}
