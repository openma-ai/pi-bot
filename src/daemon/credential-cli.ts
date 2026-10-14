import { CredentialBroker } from './runtime/credentials.ts';
import { enterCredential } from './hidden-entry.ts';
const broker = new CredentialBroker();
try {
    const scope = {
        botId: 'local-host', taskId: 'local-entry-check', tool: 'local-entry-check'
    };
    const receipt = await enterCredential(broker, scope, 'Credential entry check');
    const status = await broker.use(receipt.reference, scope, async () => {
    });
    console.log(JSON.stringify({
        type: 'credential_entry', ...status, note: 'Input consumed locally, immediately deleted; no provider request made.'
    }));
}
catch {
    console.error('Credential entry did not complete');
    process.exitCode = 1;
}
finally {
    broker.close();
}
