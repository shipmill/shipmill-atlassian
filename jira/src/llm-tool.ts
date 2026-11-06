import type { ChatResponse } from '@forge/llm';
import { object, type Fields } from '@shipmill-atlassian/shared/parse';

// The one tool call a forced-tool prompt must come back with, as its parsed arguments. A
// missing or repeated call is the error the caller names, never an empty answer.
export function toolArguments(response: ChatResponse, tool: string, error: (message: string) => Error): Fields {
  const choice = response.choices[0];
  if (choice === undefined) throw error('the LLM returned no choice');
  const calls = (choice.message.tool_calls ?? []).filter((call) => call.function.name === tool);
  if (calls.length !== 1) {
    throw error(`expected one ${tool} call, got ${calls.length} (finish_reason ${choice.finish_reason})`);
  }
  // The type says the arguments arrive parsed; a raw JSON string is read the same way
  const raw: unknown = calls[0]?.function.arguments;
  return object(typeof raw === 'string' ? JSON.parse(raw) : raw, tool);
}

export function logUsage(log: (line: string) => void, what: string, started: number, response: ChatResponse): void {
  const usage = response.usage;
  log(`${what}: ${Date.now() - started} ms, ${usage?.input_tokens ?? '?'} in / ${usage?.output_tokens ?? '?'} out`);
}
