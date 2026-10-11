import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export const delayTool = defineTool({
    name: "demo_delay",
    label: "Safe delay",
    description: "Wait locally, then return a label. No shell, files, or network.",
    parameters: Type.Object({
        label: Type.String(),
        ms: Type.Number({
            minimum: 0, maximum: 1000
        }),
    }),
    async execute(_id, p, signal) {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => signal?.removeEventListener("abort", abort);
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, p.ms);
            const abort = () => {
                clearTimeout(timer);
                cleanup();
                reject(signal?.reason ?? new Error("cancelled"));
            };
            signal?.addEventListener("abort", abort, {
                once: true
            });
            if (signal?.aborted)
                abort();
        });
        return {
            content: [{
                    type: "text" as const, text: `${p.label} finished`
                }],
            details: {
                label: p.label
            },
        };
    },
});
export default function (pi: ExtensionAPI) {
    pi.registerTool(delayTool);
}
