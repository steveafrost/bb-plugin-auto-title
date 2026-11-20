import { humanMessages } from "./counting";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function titleMessages(row: { type: string; data: unknown }): string[] {
  if (!humanMessages(row) || !record(row.data)) return [];
  const groups = Array.isArray(row.data.inputGroups) ? row.data.inputGroups : [row.data.input];
  return groups.flatMap((group: unknown) => {
    if (!Array.isArray(group)) return [];
    const text = group.flatMap((part: unknown) =>
      record(part) && part.type === "text" && typeof part.text === "string" && part.visibility !== "agent-only"
        ? [part.text.slice(0, 320)] : [],
    ).join("\n").trim().slice(0, 320);
    return text ? [text] : [];
  });
}

/** Keep the opening, a spaced sample across the middle, and the last 12 messages. */
export function createTitleContext() {
  const earlier = new Map<number, string>();
  const recent = new Map<number, string>();
  let stride = 1;
  let count = 0;
  return {
    add(text: string) {
      const index = count++;
      recent.set(index, text);
      if (recent.size > 12) recent.delete(index - 12);
      if (index % stride === 0) earlier.set(index, text);
      if (earlier.size > 20) {
        stride *= 2;
        for (const key of earlier.keys()) if (key % stride !== 0) earlier.delete(key);
      }
    },
    payload(title: string | null, force: boolean): string | null {
      if (!count) return null;
      const messages = [...new Map([...earlier, ...recent])].sort(([a], [b]) => a - b)
        .map(([index, text]) => ({ message: index + 1, text }));
      return JSON.stringify({ title: title?.slice(0, 240) ?? null, force, totalMessages: count, messages });
    },
  };
}
