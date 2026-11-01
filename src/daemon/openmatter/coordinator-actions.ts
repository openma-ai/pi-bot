import type { Envelope } from "../../pi/types.ts";
import type { PiBotCoordinatorActions, PiBotProject } from "./project-host.ts";
import type { BotRuntime } from "../runtime/runtime.ts";

/** A pi-bot background task: no OpenMatter worker, no delegation; its completion is a job inbox event. */
export type PiJobRunner = (input: {
  sessionId: string;
  task: string;
}) => Promise<string>;

export type CoordinatorActionOptions = {
  runtime: BotRuntime | (() => BotRuntime);
  /** Opens an isolated Pi session for a background task. */
  openJob?: PiJobRunner;
  proactive?:
    | {
        createSchedule(
          source: Envelope,
          input: {
            key: string;
            prompt: string;
            at: number;
            timezone: string;
            intervalMs?: number;
          },
        ): unknown;
        listSchedules(botId: string): unknown;
      }
    | (() =>
        | {
            createSchedule(
              source: Envelope,
              input: {
                key: string;
                prompt: string;
                at: number;
                timezone: string;
                intervalMs?: number;
              },
            ): unknown;
            listSchedules(botId: string): unknown;
          }
        | undefined);
};

/**
 * Binds pi-bot's native coordinator features (ask_user, teammate messages,
 * jobs, proactive, files) to tools the coordinator can call. OpenMatter still
 * owns the Turn, the inbox and the reply path; these actions only create
 * pi-bot events that come back through the same project inbox.
 */
export const makePiBotCoordinatorActions = (
  options: CoordinatorActionOptions,
): PiBotCoordinatorActions => {
  const runtime = () =>
    typeof options.runtime === "function" ? options.runtime() : options.runtime;
  const proactive = () =>
    typeof options.proactive === "function"
      ? options.proactive()
      : options.proactive;
  return {
    askUser: ({ source, text, key, choices }) => ({
      ...runtime().askUser(source, text, key, choices),
      receipt: "Question created; the answer arrives as its own Turn.",
    }),
    sendToBot: ({ source, to, text, key }) => {
      const accepted = runtime().sendToBot(source, to, text, key);
      return {
        messageId: accepted.id,
        state: accepted.state,
        taskId: accepted.taskId,
        receipt: "Message queued for the teammate. This receipt is not an answer.",
      };
    },
    startJob: ({ source, task, key }) => {
      if (!options.openJob)
        throw new Error("Background jobs are unavailable: no Pi job runner configured");
      const job = runtime().startJob(
        source,
        "pi-bot.background",
        { task },
        key,
        async () => ({ text: await options.openJob!({ sessionId: `job:${source.id}:${key}`, task }) }),
      );
      return {
        jobId: job.id,
        state: job.state,
        taskId: job.taskId,
        receipt: "Job started. Completion arrives as an inbox event; read job_result then.",
      };
    },
    jobResult: ({ source, jobId, offset, limit }) =>
      runtime().jobResult(source.to, jobId, offset, limit),
    createSchedule: ({ source, prompt, at, timezone, intervalMs, key }) => {
      if (!proactive())
        throw new Error("Proactive scheduling is unavailable");
      const schedule = proactive()!.createSchedule(source, {
        key,
        prompt,
        at,
        timezone,
        ...(intervalMs === undefined ? {} : { intervalMs }),
      });
      return schedule as never;
    },
    listProactive: ({ source }) =>
      (proactive()?.listSchedules(source.to) ?? []) as never,
    fileWorkspace: ({ source }) => runtime().fileContext(source) as never,
    publishFile: ({ source, name, mime, key }) =>
      runtime().publishFile(source, name, mime, key) as never,
  };
};

/** Source lookup: OpenMatter's reply/message ids are pi-bot envelope ids. */
export const envelopeSource =
  (runtime: BotRuntime | (() => BotRuntime)) =>
  (_project: PiBotProject, messageId: string): Envelope | undefined =>
    (typeof runtime === "function" ? runtime() : runtime).store.get<Envelope>(
      "inbox",
      messageId,
    );
