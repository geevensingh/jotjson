export function collectStringLeaves(value: unknown, accumulator: string[] = []): string[] {
  if (typeof value === 'string') {
    accumulator.push(value);
    return accumulator;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, accumulator);
    }
    return accumulator;
  }

  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(item, accumulator);
    }
  }

  return accumulator;
}
