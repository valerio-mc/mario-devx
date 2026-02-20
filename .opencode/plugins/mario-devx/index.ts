import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { flushControlProgress, ingestControlProgressEvent, pushControlProgressLine } from "./progress-stream";
import { readRunState } from "./state";

const getIdleSessionId = (event: unknown): string | null => {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "session.idle") {
    return null;
  }
  const props = e.properties as { sessionID?: unknown } | undefined;
  return typeof props?.sessionID === "string" && props.sessionID.length > 0 ? props.sessionID : null;
};

const safePluginLog = async (
  client: { app?: { log?: (args: { body: { service: string; level: "info"; message: string; extra?: Record<string, unknown> } }) => Promise<unknown> } },
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> => {
  try {
    if (client.app?.log) {
      await client.app.log({
        body: {
          service: "mario-devx",
          level: "info",
          message,
          extra,
        },
      });
    }
  } catch {
    // Best-effort logging only.
  }
};

export const marioDevxPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx;
  const repoRoot = worktree ?? directory;
  const tools = createTools(ctx);
  const commands = createCommands();

  await safePluginLog(client, "Plugin initialized", {
    directory,
    worktree: repoRoot,
  });

  return {
    tool: tools,
    event: async ({ event }) => {
      const run = await readRunState(repoRoot);
      if (run.status !== "DOING") {
        return;
      }
      const workSessionId = run.workSessionId;
      const verifierSessionId = run.verifierSessionId;
      if (!workSessionId && !verifierSessionId) {
        return;
      }
      if (!run.controlSessionId) {
        return;
      }

      // Notify control session when the work session becomes idle.
      const idleSessionID = getIdleSessionId(event);
      if (idleSessionID && idleSessionID === workSessionId) {
        pushControlProgressLine(run.controlSessionId, {
          phase: "work",
          text: `phase idle (${run.currentPI ?? "task"})`,
          ...(run.currentPI ? { taskId: run.currentPI } : {}),
        });
        flushControlProgress(run.controlSessionId, { force: true });
        return;
      }
      if (idleSessionID && idleSessionID === verifierSessionId) {
        pushControlProgressLine(run.controlSessionId, {
          phase: "verify",
          text: `phase idle (${run.currentPI ?? "task"})`,
          ...(run.currentPI ? { taskId: run.currentPI } : {}),
        });
        flushControlProgress(run.controlSessionId, { force: true });
        return;
      }

      const accepted = ingestControlProgressEvent({
        controlSessionId: run.controlSessionId,
        event,
        ...(workSessionId ? { workSessionId } : {}),
        ...(verifierSessionId ? { verifierSessionId } : {}),
        streamWorkEvents: run.streamWorkEvents,
        streamVerifyEvents: run.streamVerifyEvents,
        ...(run.currentPI ? { taskId: run.currentPI } : {}),
      });
      if (!accepted) return;
      flushControlProgress(run.controlSessionId);
    },
    config: async (config) => {
      config.command = config.command ?? {};
      for (const command of commands) {
        config.command[command.name] = command.definition;
      }
      await safePluginLog(client, "Commands registered", {
        commandCount: commands.length,
      });
      return config;
    },
  };
};

export default marioDevxPlugin;
