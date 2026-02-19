import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState } from "./state";

const WORK_STREAM_MIN_INTERVAL_MS = 400;
const WORK_STREAM_MAX_TEXT = 220;
const workStreamState = new Map<string, { at: number; text: string }>();

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

const clipStreamText = (text: string): string => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= WORK_STREAM_MAX_TEXT) {
    return singleLine;
  }
  return `${singleLine.slice(0, WORK_STREAM_MAX_TEXT)}...`;
};

const getWorkStreamSnippet = (event: unknown): { sessionID: string; text: string } | null => {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "message.part.updated") {
    return null;
  }
  const props = e.properties as {
    delta?: unknown;
    part?: {
      sessionID?: unknown;
      type?: unknown;
      text?: unknown;
    };
  } | undefined;
  const part = props?.part;
  const sessionID = typeof part?.sessionID === "string" && part.sessionID.length > 0 ? part.sessionID : null;
  if (!sessionID) {
    return null;
  }

  if (part.type === "text" || part.type === "reasoning") {
    const chunk = typeof props?.delta === "string"
      ? props.delta
      : (typeof part.text === "string" ? part.text : "");
    const text = clipStreamText(chunk);
    return text.length > 0 ? { sessionID, text } : null;
  }

  if (part.type === "step-start") {
    return { sessionID, text: "step started" };
  }
  if (part.type === "step-finish") {
    return { sessionID, text: "step finished" };
  }
  return null;
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
      if (!run.workSessionId) {
        return;
      }
      if (!run.controlSessionId) {
        return;
      }

      const sendControlNote = async (text: string): Promise<void> => {
        try {
          await client.session.prompt({
            path: { id: run.controlSessionId as string },
            body: {
              noReply: true,
              parts: [{ type: "text", text }],
            },
          });
        } catch {
          // Best-effort event forwarding.
        }
      };

      // Notify control session when the work session becomes idle.
      const idleSessionID = getIdleSessionId(event);
      if (idleSessionID && idleSessionID === run.workSessionId) {
        const summary = `mario-devx: work phase is idle (${run.phase}${run.currentPI ? ` ${run.currentPI}` : ""}).`;
        await sendControlNote(summary);
        return;
      }

      if (!run.streamWorkEvents) {
        return;
      }

      const stream = getWorkStreamSnippet(event);
      if (!stream || stream.sessionID !== run.workSessionId) {
        return;
      }

      const throttleKey = `${run.controlSessionId}:${run.workSessionId}`;
      const now = Date.now();
      const previous = workStreamState.get(throttleKey);
      if (previous && previous.text === stream.text) {
        return;
      }
      if (previous && now - previous.at < WORK_STREAM_MIN_INTERVAL_MS) {
        return;
      }
      workStreamState.set(throttleKey, { at: now, text: stream.text });

      await sendControlNote(`mario-devx/work: ${stream.text}`);
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
