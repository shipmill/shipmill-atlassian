// A breaking change, as shipmill reads one: an entry under "### Breaking" in the
// changelog's Unreleased section (Keep a Changelog). A pull request adds a breaking change
// when its source has such an entry the destination doesn't.

const UNRELEASED = /^##\s+\[?unreleased\]?\s*$/i;
const BREAKING = /^###\s+breaking\s*$/i;
const ENTRY = /^\s*[-*]\s+(.+?)\s*$/;

export function unreleasedBreaking(text: string): string[] {
  const entries: string[] = [];
  let inUnreleased = false;
  let inBreaking = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inUnreleased = UNRELEASED.test(line);
      inBreaking = false;
    } else if (/^###\s/.test(line)) {
      inBreaking = inUnreleased && BREAKING.test(line);
    } else if (inBreaking) {
      const entry = ENTRY.exec(line)?.[1];
      if (entry !== undefined) entries.push(entry);
    }
  }
  return entries;
}

// undefined is a commit without the file, which has no breaking entries
export function addedBreaking(source: string | undefined, destination: string | undefined): string[] {
  const before = new Set(destination === undefined ? [] : unreleasedBreaking(destination));
  return (source === undefined ? [] : unreleasedBreaking(source)).filter((entry) => !before.has(entry));
}
