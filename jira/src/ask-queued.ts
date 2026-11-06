// What "Ask decisions" queued, for the panel to say: the version, the items not yet asked
// (the graph is read for exactly these), and the ones the graph had evidence on. No imports,
// since the panel's frontend bundles it.
export type AskQueued = { version: string; asked: string[]; graphRead: string[] };

export function queuedText(queued: AskQueued): string {
  if (queued.asked.length === 0) return `Nothing new to ask in ${queued.version}: every open decision already waits on an answer.`;
  const graph =
    queued.graphRead.length === 0 ? 'The Teamwork Graph had no evidence to cite.' : `The comments cite the Teamwork Graph on ${queued.graphRead.join(', ')}.`;
  return `Asking the open decisions of ${queued.version} in the background; refresh in a minute to see them asked. ${graph}`;
}
