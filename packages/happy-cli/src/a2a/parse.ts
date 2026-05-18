function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function extractA2aText(body: unknown): string | null {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    return trimmed || null;
  }

  if (!isRecord(body)) {
    return null;
  }

  if (typeof body.text === 'string') {
    const trimmed = body.text.trim();
    if (trimmed) return trimmed;
  }
  if (typeof body.message === 'string') {
    const trimmed = body.message.trim();
    if (trimmed) return trimmed;
  }
  if (typeof body.content === 'string') {
    const trimmed = body.content.trim();
    if (trimmed) return trimmed;
  }

  const content = body.content;
  if (isRecord(content)) {
    if (typeof content.text === 'string') {
      const trimmed = content.text.trim();
      if (trimmed) return trimmed;
    }
    if (typeof content.message === 'string') {
      const trimmed = content.message.trim();
      if (trimmed) return trimmed;
    }
    if (Array.isArray(content.parts)) {
      const joined = extractA2aTextFromParts(content.parts);
      if (joined) return joined;
    }
  }

  if (Array.isArray(body.parts)) {
    return extractA2aTextFromParts(body.parts);
  }

  return null;
}

export function extractA2aTitle(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const candidateKeys = ['title', 'agent', 'sender', 'source', 'from', 'name'];
  for (const key of candidateKeys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  const meta = body.meta;
  if (isRecord(meta)) {
    for (const key of candidateKeys) {
      const value = meta[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return undefined;
}

function extractA2aTextFromParts(parts: unknown[]): string | null {
  const texts = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return null;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return null;
    })
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());

  const joined = texts.join('\n').trim();
  return joined || null;
}
