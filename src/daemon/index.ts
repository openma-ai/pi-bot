/** Layer ② daemon: durable multi-bot host for the Pi plugin layer. */
export { BotRuntime } from './runtime.ts';
export { Store } from './store.ts';
export { ProactiveService, type Detector, type BackgroundWorker } from './proactive.ts';
export { createFileChangeDetector } from './proactive-detectors.ts';
export { createModelBackgroundWorker } from './proactive-model-worker.ts';
export { OpenMatterTrigger } from './openmatter-trigger.ts';
export { CredentialBroker } from './credentials.ts';
export { ChannelMessageReader, projectChannelMessage } from './channel-messages.ts';
export { livePiFactory } from './live-pi.ts';
export { startDaemon, validateMessageInput } from './server.ts';
