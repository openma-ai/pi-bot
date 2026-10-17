import { Type } from 'typebox';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ProactivePort } from './host.ts';
import { commitOutcome, monitorResource, scheduleResource, type ReadEvidence } from './state-protection.ts';
import type { Envelope, Monitor, Schedule } from './types.ts';
export const proactiveToolNames = ['schedule_create', 'schedule_list', 'schedule_cancel', 'monitor_create', 'monitor_list', 'monitor_dry_run', 'monitor_enable', 'monitor_cancel', 'background_work', 'background_result', 'background_cancel', 'memory_apply', 'memory_read'];
/** Model surface only. Scheduling/detection/approval remains in the trusted host.
 * Trigger reads record the revision shown to the model; trigger writes commit against it. */
export function createProactiveExtension(service: ProactivePort, botId: string, own: (id?: string, routed?: boolean) => Envelope, evidence: ReadEvidence): ExtensionFactory {
    return pi => {
        const shown = <T extends Schedule | Monitor>(kind: 'schedule' | 'monitor', items: T[]) => {
            for (const item of items)
                evidence.observe(kind === 'schedule' ? scheduleResource(item.id) : monitorResource(item.id), String(item.revision));
            return items;
        };
        const source = {
            source_message_id: Type.Optional(Type.String())
        };
        const key = Type.String({
            minLength: 1, maxLength: 256
        });
        const prompt = Type.String({
            minLength: 1, maxLength: 16000
        });
        const register = (name: string, description: string, parameters: any, execute: (params: any, toolCallId: string) => unknown) => pi.registerTool({
            name, label: name.replaceAll('_', ' '), description, parameters,
            async execute(id, p) {
                const value = await execute(p, id);
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
        }), p => shown('schedule', [service.createSchedule(own(p.source_message_id, true), p)])[0]);
        register('schedule_list', 'List own persistent schedules with their current revision.', Type.Object({}), () => shown('schedule', service.listSchedules(botId)));
        register('schedule_cancel', 'Cancel own schedule and invalidate late effects. Already-started tools continue. Commits against the schedule revision you last listed; if it changed, returns status "conflict" with nothing applied.', Type.Object({
            id: Type.String()
        }), (p, id) => {
            own();
            return commitOutcome(service.cancelSchedule(botId, p.id, evidence.decision(id, scheduleResource(p.id))), s => {
                shown('schedule', [s]);
                return {
                    cancelled: p.id, revision: s.revision
                };
            });
        });
        register('monitor_create', 'Create disabled bounded monitor using a host-allowlisted read-only detector. Run dry-run before enabling. Silent detections do not wake the model; deadline emits closure.', Type.Object({
            ...source, key, prompt, detector: Type.String(), intervalMs: Type.Integer({
                minimum: 1000
            }), deadline: Type.Integer({
                minimum: 0
            })
        }), p => shown('monitor', [service.createMonitor(own(p.source_message_id, true), p)])[0]);
        register('monitor_list', 'List own persistent monitors, revision, cursor and last decision.', Type.Object({}), () => shown('monitor', service.listMonitors(botId)));
        register('monitor_dry_run', 'Exercise detector without saving cursor/baseline or firing an event.', Type.Object({
            id: Type.String()
        }), p => service.dryRunMonitor(botId, p.id));
        register('monitor_enable', 'Enable own monitor after checking actual dry-run observation. Commits against the monitor revision you last listed or created; if it changed, returns status "conflict" with nothing applied.', Type.Object({
            id: Type.String()
        }), (p, id) => {
            own();
            return commitOutcome(service.enableMonitor(botId, p.id, evidence.decision(id, monitorResource(p.id))), m => {
                shown('monitor', [m]);
                return {
                    enabled: p.id, revision: m.revision
                };
            });
        });
        register('monitor_cancel', 'Cancel own monitor, invalidate late results. Commits against the monitor revision you last listed; if it changed, returns status "conflict" with nothing applied.', Type.Object({
            id: Type.String()
        }), (p, id) => {
            own();
            return commitOutcome(service.cancelMonitor(botId, p.id, evidence.decision(id, monitorResource(p.id))), m => {
                shown('monitor', [m]);
                return {
                    cancelled: p.id, revision: m.revision
                };
            });
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
