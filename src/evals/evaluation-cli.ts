import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { enterCredential } from '../daemon/hidden-entry.ts';
import { CredentialBroker } from '../daemon/runtime/credentials.ts';
import { runEvaluation, SMOKE_CAP, scenarios } from './evaluation.ts';
import { configureSmokeProvider } from './smoke-provider.ts';
const args = process.argv.slice(2);
const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const real = args.includes('--real');
const dry = args.includes('--dry-run');
const modelId = value('--model') ?? 'deepseek-v4-flash';
const host = 'api.deepseek.com';
let models: ModelRuntime | undefined;
let authDir: string | undefined;
const broker = new CredentialBroker();
try {
    if (!['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'].includes(modelId))
        throw Error('Unsupported smoke model');
    // There is no secret argument, environment import, or DSH credential import.
    if (args.some(a => /key|secret|token|host|endpoint/i.test(a)))
        throw Error('Credential and endpoint arguments are not accepted');
    if (dry) {
        console.log(JSON.stringify({
            mode: 'dry-run', providerHostname: host, modelId, scenarios: scenarios.map(s => ({
                id: s.id, scheduledMessages: s.events.length, expectedTasks: s.expected.length
            })), caps: SMOKE_CAP, thinking: {
                enabled: true, effort: 'high', outputCapIncludesReasoningAndFinal: true
            }, backgroundSummary: false, paidRequests: 0, note: 'Real run requires explicit approval flag and direct hidden local TTY entry; no existing DSH auth bridge was verified.'
        }, null, 2));
    }
    else {
        if (real) {
            if (Number(value('--approved-budget-usd')) !== SMOKE_CAP.approvedUsdNeeded || modelId === 'deepseek-v4-pro')
                throw Error('Real Flash run requires exact revised USD approval; Pro needs a separately reviewed pricing plan');
            authDir = await mkdtemp(join(tmpdir(), 'pi-bot-model-metadata-'));
            models = await ModelRuntime.create({
                credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(authDir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false
            });
            configureSmokeProvider(models, modelId);
            const scope = {
                botId: 'evaluation-host', taskId: 'behavioral-smoke', tool: 'provider:pi-evaluation-deepseek'
            };
            const receipt = await enterCredential(broker, scope, 'DeepSeek API credential');
            const submitted = await broker.use(receipt.reference, scope, async (secret) => {
                await models!.setRuntimeApiKey('pi-evaluation-deepseek', secret);
            });
            if (submitted.state !== 'completed')
                throw Error('Provider authentication setup failed');
        }
        const report = await runEvaluation({
            mode: real ? 'real' : 'scripted', modelRuntime: models, model: models?.getModel('pi-evaluation-deepseek', modelId)
        });
        // Report contains only fixed fixture outcome fields/routes/counters. Native
        // transcripts live in a temporary directory removed by runEvaluation.
        const output = value('--report');
        if (output)
            await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
                mode: 0o600
            });
        console.log(JSON.stringify(report, null, 2));
        if (!report.pass)
            process.exitCode = 1;
    }
}
catch {
    console.error('Evaluation could not complete; verify approved model/budget and local TTY entry. No raw provider error is printed.');
    process.exitCode = 1;
}
finally {
    broker.close();
    if (models)
        await models.removeRuntimeApiKey('pi-evaluation-deepseek').catch(() => {
        });
    if (authDir)
        await rm(authDir, {
            recursive: true, force: true
        });
}
