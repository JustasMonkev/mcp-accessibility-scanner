export function median(samples) {
  const sorted = [...samples].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
