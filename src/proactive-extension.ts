import { Type } from 'typebox';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Envelope } from './store.ts';
import type { ProactiveService } from './proactive.ts';
export const proactiveToolNames = ['schedule_create', 'schedule_list', 'schedule_cancel', 'monitor_create', 'monitor_list', 'monitor_dry_run', 'monitor_enable', 'monitor_cancel', 'background_work', 'background_result', 'background_cancel', 'memory_apply', 'memory_read'];
/** Model surface only. Scheduling/detection/approval remains in the trusted host. */
export function createProactiveExtension(service: ProactiveService, botId: string, own: (id?: string, routed?: boolean) => Envelope): ExtensionFactory {
    return pi => {
        const source = {
            source_message_id: Type.Optional(Type.String())
        };
        const key = Type.String({
            minLength: 1, maxLength: 256
        });
        const prompt = Type.String({
            minLength: 1, maxLength: 16000
        });
        const register = (name: string, description: string, parameters: any, execute: (params: any) => unknown) => pi.registerTool({
            name, label: name.replaceAll('_', ' '), description, parameters,
            async execute(_id, p) {
                const value = await execute(p);
                return {
                    content: [{
                            type: 'text', text: JSON.stringify(value)
                        }], details: value
                };
            }
        } as ToolDefinition);
        register('schedule_create', 'Create persistent one-shot or fixed elapsed interval task. at is Unix milliseconds; timezone labels intent, interval is elapsed time, not a calendar cron. Stable key; only original task scope. Never promise completion from a receipt.', Type.Object({
            ...source, key, prompt, at: Type.Integer({
                minimum: 0
            }), timezone: Type.String(), intervalMs: Type.Optional(Type.Integer({
                minimum: 1000
            })), misfire: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('coalesce'), Type.Literal('catchup')])), overlap: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('queue')]))
        }), p => service.createSchedule(own(p.source_message_id, true), p));
        register('schedule_list', 'List own persistent schedules.', Type.Object({}), () => service.listSchedules(botId));
        register('schedule_cancel', 'Cancel own schedule and invalidate late effects. Already-started tools continue.', Type.Object({
            id: Type.String()
        }), p => {
            own();
            service.cancelSchedule(botId, p.id);
            return {
                cancelled: p.id
            };
        });
        register('monitor_create', 'Create disabled bounded monitor using a host-allowlisted read-only detector. Run dry-run before enabling. Silent detections do not wake the model; deadline emits closure.', Type.Object({
            ...source, key, prompt, detector: Type.String(), intervalMs: Type.Integer({
                minimum: 1000
            }), deadline: Type.Integer({
                minimum: 0
            })
        }), p => service.createMonitor(own(p.source_message_id, true), p));
        register('monitor_list', 'List own persistent monitors, cursor and last decision.', Type.Object({}), () => service.listMonitors(botId));
        register('monitor_dry_run', 'Exercise detector without saving cursor/baseline or firing an event.', Type.Object({
            id: Type.String()
        }), p => service.dryRunMonitor(botId, p.id));
        register('monitor_enable', 'Enable own monitor after checking actual dry-run observation.', Type.Object({
            id: Type.String()
        }), p => {
            own();
            service.enableMonitor(botId, p.id);
            return {
                enabled: p.id
            };
        });
        register('monitor_cancel', 'Cancel own monitor, invalidate late results.', Type.Object({
            id: Type.String()
        }), p => {
            own();
            service.cancelMonitor(botId, p.id);
            return {
                cancelled: p.id
            };
        });
        register('background_work', 'Run bounded host-allowlisted research or memory worker using explicit own host evidence IDs. Independent reviewer must approve. No implicit external network permission or automatic user notification.', Type.Object({
            ...source, key, kind: Type.Union([Type.Literal('research'), Type.Literal('memory')]), evidenceRefs: Type.Array(Type.String(), {
                minItems: 1, maxItems: 32
            }), memoryKey: Type.Optional(key)
        }), p => service.startBackgroundWork(own(p.source_message_id, true), p));
        register('background_result', 'Retrieve own approved candidate and independent review; marks result consumed separately from execution. Notify user only through send_message when useful and authorized.', Type.Object({
            id: Type.String()
        }), p => service.readProposal(botId, p.id));
        register('background_cancel', 'Cancel own background proposal and prevent late publication or memory application.', Type.Object({
            id: Type.String()
        }), p => {
            own();
            service.cancelBackgroundWork(botId, p.id);
            return {
                cancelled: p.id
            };
        });
        register('memory_apply', 'Apply only independently approved memory with unchanged evidence and snapshot version. Does not send user messages.', Type.Object({
            id: Type.String()
        }), p => {
            own();
            return service.applyMemory(botId, p.id);
        });
        register('memory_read', 'Read own approved stored memory by key.', Type.Object({
            key
        }), p => service.getMemory(botId, p.key) ?? null);
    };
}
