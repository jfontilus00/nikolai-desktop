import { AgentEvent } from "./types";
import { agenticStreamChat } from "../agentic";

export async function* runAgentAsEvents(
  userMessage: string,
  opts: { model: string }
): AsyncGenerator<AgentEvent> {
  let fullText = "";

  try {
    const queue: string[] = [];

    await agenticStreamChat({
      messages: [{ role: "user", content: userMessage }],
      model: opts.model,

      onToken(token: string) {
        queue.push(token);
      },

      onToolCall: (name: string, args: unknown) => {
        console.log("[voice tool]", name);
      },
    });

    while (queue.length > 0) {
      const token = queue.shift()!;

      fullText += token;

      yield {
        type: "token",
        text: token,
      };
    }

    yield {
      type: "final",
      fullText,
    };
  } catch (err) {
    yield {
      type: "error",
      message: (err as Error).message,
    };
  }
}
