export function greeting(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name must not be blank");
  return `Hello, ${trimmed}!`;
}
